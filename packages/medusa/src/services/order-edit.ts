import { EntityManager, IsNull } from "typeorm"
import { FindConfig } from "../types/common"
import { buildQuery, isDefined } from "../utils"
import { MedusaError } from "medusa-core-utils"
import { OrderEditRepository } from "../repositories/order-edit"
import {
  LineItem,
  Order,
  OrderEdit,
  OrderEditItemChangeType,
  OrderEditStatus,
} from "../models"
import { TransactionBaseService } from "../interfaces"
import {
  EventBusService,
  InventoryService,
  LineItemService,
  OrderEditItemChangeService,
  OrderService,
  TaxProviderService,
  TotalsService,
} from "./index"
import { CreateOrderEditInput, UpdateOrderEditInput } from "../types/order-edit"
import region from "./region"
import LineItemAdjustmentService from "./line-item-adjustment"

type InjectedDependencies = {
  manager: EntityManager
  orderEditRepository: typeof OrderEditRepository
  orderService: OrderService
  eventBusService: EventBusService
  totalsService: TotalsService
  lineItemService: LineItemService
  orderEditItemChangeService: OrderEditItemChangeService
  inventoryService: InventoryService
  lineItemAdjustmentService: LineItemAdjustmentService
  taxProviderService: TaxProviderService
}

export default class OrderEditService extends TransactionBaseService {
  static readonly Events = {
    CREATED: "order-edit.created",
    UPDATED: "order-edit.updated",
    DECLINED: "order-edit.declined",
    REQUESTED: "order-edit.requested",
  }

  protected transactionManager_: EntityManager | undefined
  protected readonly manager_: EntityManager
  protected readonly orderEditRepository_: typeof OrderEditRepository
  protected readonly orderService_: OrderService
  protected readonly lineItemService_: LineItemService
  protected readonly eventBusService_: EventBusService
  protected readonly totalsService_: TotalsService
  protected readonly orderEditItemChangeService_: OrderEditItemChangeService
  protected readonly inventoryService_: InventoryService
  protected readonly lineItemAdjustmentService_: LineItemAdjustmentService
  protected readonly taxProviderService_: TaxProviderService

  constructor({
    manager,
    orderEditRepository,
    orderService,
    lineItemService,
    eventBusService,
    totalsService,
    orderEditItemChangeService,
    inventoryService,
    lineItemAdjustmentService,
    taxProviderService,
  }: InjectedDependencies) {
    // eslint-disable-next-line prefer-rest-params
    super(arguments[0])

    this.manager_ = manager
    this.orderEditRepository_ = orderEditRepository
    this.orderService_ = orderService
    this.lineItemService_ = lineItemService
    this.eventBusService_ = eventBusService
    this.totalsService_ = totalsService
    this.orderEditItemChangeService_ = orderEditItemChangeService
    this.inventoryService_ = inventoryService
    this.lineItemAdjustmentService_ = lineItemAdjustmentService
    this.taxProviderService_ = taxProviderService
  }

  async retrieve(
    orderEditId: string,
    config: FindConfig<OrderEdit> = {}
  ): Promise<OrderEdit | never> {
    const manager = this.transactionManager_ ?? this.manager_
    const orderEditRepository = manager.getCustomRepository(
      this.orderEditRepository_
    )
    const { relations, ...query } = buildQuery({ id: orderEditId }, config)

    const orderEdit = await orderEditRepository.findOneWithRelations(
      relations as (keyof OrderEdit)[],
      query
    )

    if (!orderEdit) {
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        `Order edit with id ${orderEditId} was not found`
      )
    }

    return orderEdit
  }

  protected async retrieveActive(
    orderId: string,
    config: FindConfig<OrderEdit> = {}
  ): Promise<OrderEdit | undefined> {
    const manager = this.transactionManager_ ?? this.manager_
    const orderEditRepository = manager.getCustomRepository(
      this.orderEditRepository_
    )

    const query = buildQuery(
      {
        order_id: orderId,
        confirmed_at: IsNull(),
        canceled_at: IsNull(),
        declined_at: IsNull(),
      },
      config
    )
    return await orderEditRepository.findOne(query)
  }

  /**
   * Compute line items across order and order edit
   * - if an item have been removed, it will appear in the removedItems collection and will not appear in the item collection
   * - if an item have been updated, it will appear in the item collection with id being the id of the original item and the rest of the data being the data of the new item generated from the update
   * - if an item have been added, it will appear in the item collection with id being the id of the new item and the rest of the data being the data of the new item generated from the add
   * @param orderEditId
   */
  async computeLineItems(
    orderEditId: string
  ): Promise<{ items: LineItem[]; removedItems: LineItem[] }> {
    const manager = this.transactionManager_ ?? this.manager_

    const lineItemServiceTx = this.lineItemService_.withTransaction(manager)

    const orderEdit = await this.retrieve(orderEditId, {
      select: ["id", "order_id", "changes"],
      relations: ["changes", "changes.original_line_item", "changes.line_item"],
    })

    const items: LineItem[] = []
    const orderEditRemovedItemsMap: Map<string, LineItem> = new Map()
    const orderEditUpdatedItemsMap: Map<string, LineItem> = new Map()

    for (const change of orderEdit.changes) {
      const lineItemId =
        change.type === OrderEditItemChangeType.ITEM_REMOVE
          ? change.original_line_item_id!
          : change.line_item_id!

      const lineItem = await lineItemServiceTx.retrieve(lineItemId!, {
        relations: ["tax_lines", "adjustments"],
      })

      if (change.type === OrderEditItemChangeType.ITEM_REMOVE) {
        orderEditRemovedItemsMap.set(change.original_line_item_id!, lineItem)
        continue
      }

      if (change.type === OrderEditItemChangeType.ITEM_ADD) {
        items.push(lineItem)
        continue
      }

      orderEditUpdatedItemsMap.set(change.original_line_item_id!, {
        ...lineItem,
        id: change.original_line_item_id!,
      } as LineItem)
    }

    const originalLineItems = await this.lineItemService_
      .withTransaction(manager)
      .list(
        {
          order_id: orderEdit.order_id,
        },
        {
          relations: ["tax_lines", "adjustments"],
        }
      )

    for (const originalLineItem of originalLineItems) {
      const itemRemoved = orderEditRemovedItemsMap.get(originalLineItem.id)
      if (itemRemoved) {
        continue
      }

      const updatedLineItem = orderEditUpdatedItemsMap.get(originalLineItem.id)
      const lineItem = updatedLineItem ?? originalLineItem
      items.push(lineItem)
    }

    return { items, removedItems: [...orderEditRemovedItemsMap.values()] }
  }

  /**
   * Compute and return the different totals from the order edit id
   * @param orderEditId
   */
  async getTotals(orderEditId: string): Promise<{
    shipping_total: number
    gift_card_total: number
    gift_card_tax_total: number
    discount_total: number
    tax_total: number | null
    subtotal: number
    total: number
  }> {
    const manager = this.transactionManager_ ?? this.manager_
    const { order_id } = await this.retrieve(orderEditId, {
      select: ["order_id"],
    })
    const order = await this.orderService_
      .withTransaction(manager)
      .retrieve(order_id, {
        relations: [
          "discounts",
          "discounts.rule",
          "gift_cards",
          "region",
          "region.tax_rates",
          "shipping_methods",
          "shipping_methods.tax_lines",
        ],
      })
    let { items } = await this.computeLineItems(orderEditId)

    // For the purpose of the computation, we have to map the item id to the new item id instead of the original one for the correspondence of the tax lines and adjustments
    items = items.map((item) => {
      item.id = item.tax_lines[0]?.item_id ?? item.id
      return item
    })
    const computedOrder = { ...order, items } as Order

    const totalsServiceTx = this.totalsService_.withTransaction(manager)

    const shipping_total = await totalsServiceTx.getShippingTotal(computedOrder)
    const { total: gift_card_total, tax_total: gift_card_tax_total } =
      await totalsServiceTx.getGiftCardTotal(computedOrder)
    const discount_total = await totalsServiceTx.getDiscountTotal(computedOrder)
    const tax_total = await totalsServiceTx.getTaxTotal(computedOrder)
    const subtotal = await totalsServiceTx.getSubtotal(computedOrder)
    const total = await totalsServiceTx.getTotal(computedOrder)

    return {
      shipping_total,
      gift_card_total,
      gift_card_tax_total,
      discount_total,
      tax_total,
      subtotal,
      total,
    }
  }

  async create(
    data: CreateOrderEditInput,
    context: { loggedInUserId: string }
  ): Promise<OrderEdit> {
    return await this.atomicPhase_(async (transactionManager) => {
      const activeOrderEdit = await this.retrieveActive(data.order_id)
      if (activeOrderEdit) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `An active order edit already exists for the order ${data.order_id}`
        )
      }

      const orderEditRepository = transactionManager.getCustomRepository(
        this.orderEditRepository_
      )

      const orderEditToCreate = orderEditRepository.create({
        order_id: data.order_id,
        internal_note: data.internal_note,
        created_by: context.loggedInUserId,
      })

      const orderEdit = await orderEditRepository.save(orderEditToCreate)

      await this.eventBusService_
        .withTransaction(transactionManager)
        .emit(OrderEditService.Events.CREATED, { id: orderEdit.id })

      return orderEdit
    })
  }

  async update(
    orderEditId: string,
    data: UpdateOrderEditInput
  ): Promise<OrderEdit> {
    return await this.atomicPhase_(async (manager) => {
      const orderEditRepo = manager.getCustomRepository(
        this.orderEditRepository_
      )

      const orderEdit = await this.retrieve(orderEditId)

      for (const key of Object.keys(data)) {
        if (isDefined(data[key])) {
          orderEdit[key] = data[key]
        }
      }

      const result = await orderEditRepo.save(orderEdit)

      await this.eventBusService_
        .withTransaction(manager)
        .emit(OrderEditService.Events.UPDATED, {
          id: result.id,
        })

      return result
    })
  }

  async delete(orderEditId: string): Promise<void> {
    return await this.atomicPhase_(async (manager) => {
      const orderEditRepo = manager.getCustomRepository(
        this.orderEditRepository_
      )

      const edit = await orderEditRepo.findOne({ where: { id: orderEditId } })

      if (!edit) {
        return
      }

      if (edit.status !== OrderEditStatus.CREATED) {
        throw new MedusaError(
          MedusaError.Types.NOT_ALLOWED,
          `Cannot delete order edit with status ${edit.status}`
        )
      }

      await orderEditRepo.remove(edit)
    })
  }

  async decline(
    orderEditId: string,
    context: {
      declinedReason?: string
      loggedInUser?: string
    }
  ): Promise<OrderEdit> {
    return await this.atomicPhase_(async (manager) => {
      const orderEditRepo = manager.getCustomRepository(
        this.orderEditRepository_
      )

      const { loggedInUser, declinedReason } = context

      const orderEdit = await this.retrieve(orderEditId)

      if (orderEdit.status === OrderEditStatus.DECLINED) {
        return orderEdit
      }

      if (orderEdit.status !== OrderEditStatus.REQUESTED) {
        throw new MedusaError(
          MedusaError.Types.NOT_ALLOWED,
          `Cannot decline an order edit with status ${orderEdit.status}.`
        )
      }

      orderEdit.declined_at = new Date()
      orderEdit.declined_by = loggedInUser
      orderEdit.declined_reason = declinedReason

      const result = await orderEditRepo.save(orderEdit)

      await this.eventBusService_
        .withTransaction(manager)
        .emit(OrderEditService.Events.DECLINED, {
          id: result.id,
        })

      return result
    })
  }

  /**
   * Create or update order edit item change line item and apply the quatity
   * - If the item change already exists then update the quantity of the line item as well as the line adjustments and tax lines
   * - If the item change does not exists then create the item change and cloned the original line item with the quantity as well as the line adjustments and tax lines
   * @param orderEditId
   * @param originalLineItemId
   * @param data
   */
  async updateLineItem(
    orderEditId: string,
    originalLineItemId: string,
    data: { quantity: number }
  ): Promise<void> {
    return await this.atomicPhase_(async (manager) => {
      const orderEdit = await this.retrieve(orderEditId, {
        select: [
          "order_id",
          "created_at",
          "requested_at",
          "confirmed_at",
          "declined_at",
          "canceled_at",
        ],
      })

      const isOrderEditActive = OrderEditService.isOrderEditActive(orderEdit)
      if (!isOrderEditActive) {
        throw new MedusaError(
          MedusaError.Types.NOT_ALLOWED,
          `Can not update an item on the order edit ${orderEditId} with the status ${orderEdit.status}`
        )
      }

      const originalLineItem = await this.lineItemService_
        .withTransaction(manager)
        .retrieve(originalLineItemId, { select: ["id", "order_id"] })

      if (orderEdit.order_id !== originalLineItem.order_id) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `Invalid line item id ${originalLineItemId} it does not belong to the same order ${orderEdit.order_id} as the order edit.`
        )
      }

      const orderEditItemChangeServiceTx =
        this.orderEditItemChangeService_.withTransaction(manager)

      let change = (
        await orderEditItemChangeServiceTx.list(
          {
            original_line_item_id: originalLineItem.id,
            type: OrderEditItemChangeType.ITEM_UPDATE,
          },
          {
            relations: ["line_item", "original_line_item"],
          }
        )
      ).pop()

      if (!change) {
        const newLineItem = await this.cloneOriginalLineItem(
          orderEditId,
          originalLineItem.id,
          { quantity: data.quantity }
        )
        await orderEditItemChangeServiceTx.create({
          type: OrderEditItemChangeType.ITEM_UPDATE,
          order_edit_id: orderEditId,
          original_line_item_id: originalLineItem.id,
          line_item_id: newLineItem.id,
        })
        return
      }

      await this.updateClonedLineItem(orderEditId, change.line_item_id!, {
        quantity: data.quantity,
      })
    })
  }

  protected async updateClonedLineItem(
    orderEditId: string,
    lineItemId: string,
    data: { quantity: number }
  ) {
    const manager = this.transactionManager_ ?? this.manager_

    const lineItemServiceTx = this.lineItemService_.withTransaction(manager)

    let clonedLineItem = await lineItemServiceTx.retrieve(lineItemId, {
      relations: ["variant"],
    })

    const diffQuantity = data.quantity - clonedLineItem.fulfilled_quantity
    if (diffQuantity > 0) {
      await this.inventoryService_
        .withTransaction(manager)
        .confirmInventory(clonedLineItem.variant_id, diffQuantity)
    }

    clonedLineItem = await lineItemServiceTx.update(clonedLineItem.id, {
      quantity: data.quantity,
    })

    await this.refreshAdjustmentAndTaxLines(orderEditId, clonedLineItem.id)

    return clonedLineItem
  }

  protected async cloneOriginalLineItem(
    orderEditId: string,
    lineItemId: string,
    data: { quantity: number }
  ): Promise<LineItem> {
    const manager = this.transactionManager_ ?? this.manager_

    const lineItemServiceTx = this.lineItemService_.withTransaction(manager)

    const lineItem = await lineItemServiceTx.retrieve(lineItemId)

    const diffQuantity = data.quantity - lineItem.fulfilled_quantity
    if (diffQuantity > 0) {
      await this.inventoryService_
        .withTransaction(manager)
        .confirmInventory(lineItem.variant_id, diffQuantity)
    }

    const clonedLineItemData = {
      ...lineItem,
      id: undefined,
      order_id: undefined,
      cart_id: undefined,
      quantity: data.quantity,
      claim_order_id: undefined,
      swap_id: undefined,
    }
    const clonedLineItem = await lineItemServiceTx.create(clonedLineItemData)

    await this.refreshAdjustmentAndTaxLines(orderEditId, clonedLineItem.id)

    return clonedLineItem
  }

  protected async refreshAdjustmentAndTaxLines(
    orderEditId: string,
    lineItemId: string
  ): Promise<void> {
    const manager = this.transactionManager_ ?? this.manager_

    const orderEdit = await this.retrieve(orderEditId, {
      relations: [
        "order",
        "order.cart",
        "order.cart.customer",
        "order.cart.discounts",
        "order.cart.discounts.rule",
        "order.cart.gift_cards",
        "order.cart.region",
        "order.cart.region.tax_rates",
        "order.cart.shipping_address",
        "order.cart.shipping_methods",
        "order.region",
      ],
    })
    const lineItem = await this.lineItemService_
      .withTransaction(manager)
      .retrieve(lineItemId)

    const lineItemAdjustmentServiceTx =
      this.lineItemAdjustmentService_.withTransaction(manager)

    await lineItemAdjustmentServiceTx.delete({
      item_id: lineItem.id,
    })
    await lineItemAdjustmentServiceTx.createAdjustments(
      orderEdit.order.cart,
      lineItem
    )

    // Calculate context only on the current given line item
    orderEdit.order.items = [lineItem]
    const calcContext = await this.totalsService_
      .withTransaction(manager)
      .getCalculationContext(orderEdit.order, { exclude_shipping: true })

    const taxProviderServiceTx =
      this.taxProviderService_.withTransaction(manager)

    await taxProviderServiceTx.clearLineItemsTaxLines([lineItem.id])
    await taxProviderServiceTx.createTaxLines([lineItem], calcContext)
  }

  async decorateLineItemsAndTotals(orderEdit: OrderEdit): Promise<OrderEdit> {
    const lineItemDecoratedOrderEdit = await this.decorateLineItems(orderEdit)
    return await this.decorateTotals(lineItemDecoratedOrderEdit)
  }

  async decorateLineItems(orderEdit: OrderEdit): Promise<OrderEdit> {
    const { items, removedItems } = await this.computeLineItems(orderEdit.id)
    orderEdit.items = items
    orderEdit.removed_items = removedItems

    return orderEdit
  }

  async decorateTotals(orderEdit: OrderEdit): Promise<OrderEdit> {
    const totals = await this.getTotals(orderEdit.id)
    orderEdit.discount_total = totals.discount_total
    orderEdit.gift_card_total = totals.gift_card_total
    orderEdit.gift_card_tax_total = totals.gift_card_tax_total
    orderEdit.shipping_total = totals.shipping_total
    orderEdit.subtotal = totals.subtotal
    orderEdit.tax_total = totals.tax_total
    orderEdit.total = totals.total

    return orderEdit
  }

  async deleteItemChange(
    orderEditId: string,
    itemChangeId: string
  ): Promise<void> {
    return await this.atomicPhase_(async (manager) => {
      const itemChange = await this.orderEditItemChangeService_.retrieve(
        itemChangeId,
        { select: ["id", "order_edit_id"] }
      )

      const orderEdit = await this.retrieve(orderEditId, {
        select: ["id", "confirmed_at", "canceled_at"],
      })

      if (orderEdit.id !== itemChange.order_edit_id) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `The item change you are trying to delete doesn't belong to the OrderEdit with id: ${orderEditId}.`
        )
      }

      if (orderEdit.confirmed_at !== null || orderEdit.canceled_at !== null) {
        throw new MedusaError(
          MedusaError.Types.NOT_ALLOWED,
          `Cannot delete and item change from a ${orderEdit.status} order edit`
        )
      }

      return await this.orderEditItemChangeService_.delete(itemChangeId)
    })
  }

  async requestConfirmation(
    orderEditId: string,
    context: {
      loggedInUser?: string
    }
  ): Promise<OrderEdit> {
    return await this.atomicPhase_(async (manager) => {
      const orderEditRepo = manager.getCustomRepository(
        this.orderEditRepository_
      )

      let orderEdit = await this.retrieve(orderEditId, {
        relations: ["changes"],
        select: ["id", "requested_at"],
      })

      if (!orderEdit.changes?.length) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "Cannot request a confirmation on an edit with no changes"
        )
      }

      if (orderEdit.requested_at) {
        return orderEdit
      }

      orderEdit.requested_at = new Date()
      orderEdit.requested_by = context.loggedInUser

      orderEdit = await orderEditRepo.save(orderEdit)

      await this.eventBusService_
        .withTransaction(manager)
        .emit(OrderEditService.Events.REQUESTED, { id: orderEditId })

      return orderEdit
    })
  }

  private static isOrderEditActive(orderEdit: OrderEdit): boolean {
    return !(
      orderEdit.status === OrderEditStatus.CONFIRMED ||
      orderEdit.status === OrderEditStatus.CANCELED ||
      orderEdit.status === OrderEditStatus.DECLINED
    )
  }
}
