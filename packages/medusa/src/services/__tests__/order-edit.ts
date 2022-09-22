import { IdMap, MockManager, MockRepository } from "medusa-test-utils"
import {
  EventBusService,
  InventoryService,
  LineItemService,
  OrderEditItemChangeService,
  OrderEditService,
  OrderService,
  TaxProviderService,
  TotalsService,
} from "../index"
import { OrderEditItemChangeType, OrderEditStatus } from "../../models"
import { OrderServiceMock } from "../__mocks__/order"
import { EventBusServiceMock } from "../__mocks__/event-bus"
import { LineItemServiceMock } from "../__mocks__/line-item"
import { TotalsServiceMock } from "../__mocks__/totals"
import { orderEditItemChangeServiceMock } from "../__mocks__/order-edit-item-change"
import { InventoryServiceMock } from "../__mocks__/inventory"
import LineItemAdjustmentService from "../line-item-adjustment"
import { LineItemAdjustmentServiceMock } from "../__mocks__/line-item-adjustment"
import { TaxProviderServiceMock } from "../__mocks__/tax-provider"

const orderEditToUpdate = {
  id: IdMap.getId("order-edit-to-update"),
}

const orderEditWithChanges = {
  id: IdMap.getId("order-edit-with-changes"),
  order: {
    id: IdMap.getId("order-edit-with-changes-order"),
    items: [
      {
        id: IdMap.getId("line-item-1"),
      },
      {
        id: IdMap.getId("line-item-2"),
      },
    ],
  },
  changes: [
    {
      type: OrderEditItemChangeType.ITEM_REMOVE,
      id: "order-edit-with-changes-removed-change",
      original_line_item_id: IdMap.getId("line-item-1"),
      original_line_item: {
        id: IdMap.getId("line-item-1"),
      },
    },
    {
      type: OrderEditItemChangeType.ITEM_ADD,
      id: IdMap.getId("order-edit-with-changes-added-change"),
      line_item_id: IdMap.getId("line-item-3"),
      line_item: {
        id: IdMap.getId("line-item-3"),
      },
    },
    {
      type: OrderEditItemChangeType.ITEM_UPDATE,
      id: IdMap.getId("order-edit-with-changes-updated-change"),
      original_line_item_id: IdMap.getId("line-item-2"),
      original_line_item: {
        id: IdMap.getId("line-item-2"),
      },
      line_item_id: IdMap.getId("line-item-4"),
      line_item: {
        id: IdMap.getId("line-item-4"),
      },
    },
  ],
}

const orderEditWithAddedLineItem = {
  id: IdMap.getId("order-edit-with-changes"),
  order: {
    id: IdMap.getId("order-edit-change"),
    cart: {
      discounts: [{ rule: {} }],
    },
    region: { id: IdMap.getId("test-region") },
  },
}

const orderItemChangeRepositoryMock = MockRepository({
  save: (f) => Promise.resolve(f),
})

const lineItemServiceMock = {
  ...LineItemServiceMock,
  list: jest.fn().mockImplementation(() => {
    return Promise.resolve([
      {
        id: IdMap.getId("line-item-1"),
      },
      {
        id: IdMap.getId("line-item-2"),
      },
    ])
  }),
  retrieve: jest.fn().mockImplementation((id) => {
    return Promise.resolve({
      id,
    })
  }),
}

describe("OrderEditService", () => {
  afterEach(() => {
    jest.clearAllMocks()
  })

  const orderEditRepository = MockRepository({
    findOneWithRelations: (relations, query) => {
      if (query?.where?.id === IdMap.getId("order-edit-with-changes")) {
        return orderEditWithChanges
      }
      if (query?.where?.id === IdMap.getId("confirmed-order-edit")) {
        return {
          ...orderEditWithChanges,
          id: IdMap.getId("confirmed-order-edit"),
          status: OrderEditStatus.CONFIRMED,
        }
      }
      if (query?.where?.id === IdMap.getId("requested-order-edit")) {
        return {
          ...orderEditWithChanges,
          id: IdMap.getId("requested-order-edit"),
          status: OrderEditStatus.REQUESTED,
        }
      }
      if (query?.where?.id === IdMap.getId("declined-order-edit")) {
        return {
          ...orderEditWithChanges,
          id: IdMap.getId("declined-order-edit"),
          declined_reason: "wrong size",
          declined_at: new Date(),
          declined_by: "admin_user",
          status: OrderEditStatus.DECLINED,
        }
      }

      return {}
    },
    create: (data) => {
      return {
        ...orderEditWithChanges,
        ...data,
      }
    },
  })

  const orderEditService = new OrderEditService({
    manager: MockManager,
    orderEditRepository,
    orderService: OrderServiceMock as unknown as OrderService,
    eventBusService: EventBusServiceMock as unknown as EventBusService,
    totalsService: TotalsServiceMock as unknown as TotalsService,
    lineItemService: lineItemServiceMock as unknown as LineItemService,
    orderEditItemChangeService:
      orderEditItemChangeServiceMock as unknown as OrderEditItemChangeService,
    inventoryService: InventoryServiceMock as unknown as InventoryService,
    lineItemAdjustmentService:
      LineItemAdjustmentServiceMock as unknown as LineItemAdjustmentService,
    orderItemChangeRepository: orderItemChangeRepositoryMock,
    taxProviderService: TaxProviderServiceMock as unknown as TaxProviderService,
  })

  it("should retrieve an order edit and call the repository with the right arguments", async () => {
    await orderEditService.retrieve(IdMap.getId("order-edit-with-changes"))
    expect(orderEditRepository.findOneWithRelations).toHaveBeenCalledTimes(1)
    expect(orderEditRepository.findOneWithRelations).toHaveBeenCalledWith(
      undefined,
      {
        where: { id: IdMap.getId("order-edit-with-changes") },
      }
    )
  })

  it("should update an order edit with the right arguments", async () => {
    await orderEditService.update(IdMap.getId("order-edit-to-update"), {
      internal_note: "test note",
    })
    expect(orderEditRepository.save).toHaveBeenCalledTimes(1)
    expect(orderEditRepository.save).toHaveBeenCalledWith({
      internal_note: "test note",
    })
  })

  it("should compute the items from the changes and attach them to the orderEdit", async () => {
    const { items, removedItems } = await orderEditService.computeLineItems(
      IdMap.getId("order-edit-with-changes")
    )

    expect(items.length).toBe(2)
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: IdMap.getId("line-item-2"),
        }),
        expect.objectContaining({
          id: IdMap.getId("line-item-3"),
        }),
      ])
    )

    expect(removedItems.length).toBe(1)
    expect(removedItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: IdMap.getId("line-item-1"),
        }),
      ])
    )
  })

  it("should create an order edit and call the repository with the right arguments as well as the event bus service", async () => {
    const data = {
      order_id: IdMap.getId("order-edit-order-id"),
      internal_note: "internal note",
    }
    await orderEditService.create(data, {
      loggedInUserId: IdMap.getId("admin_user"),
    })

    expect(orderEditRepository.create).toHaveBeenCalledTimes(1)
    expect(orderEditRepository.create).toHaveBeenCalledWith({
      order_id: data.order_id,
      internal_note: data.internal_note,
      created_by: IdMap.getId("admin_user"),
    })
    expect(EventBusServiceMock.emit).toHaveBeenCalledTimes(1)
    expect(EventBusServiceMock.emit).toHaveBeenCalledWith(
      OrderEditService.Events.CREATED,
      { id: expect.any(String) }
    )
  })

  describe("decline", () => {
    it("declines an order edit", async () => {
      const result = await orderEditService.decline(
        IdMap.getId("requested-order-edit"),
        {
          declinedReason: "I requested a different color for the new product",
          loggedInUser: "admin_user",
        }
      )

      expect(result).toEqual(
        expect.objectContaining({
          id: IdMap.getId("requested-order-edit"),
          declined_at: expect.any(Date),
          declined_reason: "I requested a different color for the new product",
          declined_by: "admin_user",
        })
      )
    })

    it("fails to decline a confirmed order edit", async () => {
      await expect(
        orderEditService.decline(IdMap.getId("confirmed-order-edit"), {
          declinedReason: "I requested a different color for the new product",
          loggedInUser: "admin_user",
        })
      ).rejects.toThrowError(
        "Cannot decline an order edit with status confirmed."
      )
    })

    it("fails to re-decline an already declined order edit", async () => {
      const result = await orderEditService.decline(
        IdMap.getId("declined-order-edit"),
        {
          declinedReason: "I requested a different color for the new product",
          loggedInUser: "admin_user",
        }
      )

      expect(result).toEqual(
        expect.objectContaining({
          id: IdMap.getId("declined-order-edit"),
          declined_at: expect.any(Date),
          declined_reason: "wrong size",
          declined_by: "admin_user",
          status: "declined",
        })
      )
    })
  })

  describe("requestConfirmation", () => {
    describe("created edit", () => {
      const orderEditId = IdMap.getId("order-edit-with-changes")
      const userId = IdMap.getId("user-id")
      let result

      beforeEach(async () => {
        result = await orderEditService.requestConfirmation(orderEditId, {
          loggedInUser: userId,
        })
      })

      it("sets fields correctly for update", async () => {
        expect(result).toEqual(
          expect.objectContaining({
            requested_at: expect.any(Date),
            requested_by: userId,
          })
        )

        expect(orderEditRepository.save).toHaveBeenCalledWith({
          ...orderEditWithChanges,
          requested_at: expect.any(Date),
          requested_by: userId,
        })

        expect(EventBusServiceMock.emit).toHaveBeenCalledWith(
          OrderEditService.Events.REQUESTED,
          { id: orderEditId }
        )
      })
    })

    describe("requested edit", () => {
      const orderEditId = IdMap.getId("requested-order-edit")
      const userId = IdMap.getId("user-id")
      let result

      beforeEach(async () => {
        result = await orderEditService.requestConfirmation(orderEditId, {
          loggedInUser: userId,
        })
      })

      afterEach(() => {
        jest.clearAllMocks()
      })

      it("doesn't emit requested event", () => {
        expect(EventBusServiceMock.emit).toHaveBeenCalledTimes(0)
      })

      it("doesn't call save", async () => {
        expect(result).toEqual(
          expect.objectContaining({
            requested_at: expect.any(Date),
            requested_by: userId,
          })
        )

        expect(orderEditRepository.save).toHaveBeenCalledTimes(0)
      })
    })
  })

  it("should add a line item to an order edit", async () => {
    await orderEditService.addLineItem(IdMap.getId("order-edit-with-changes"), {
      variant_id: IdMap.getId("to-be-added-variant"),
      quantity: 3,
    })

    expect(InventoryServiceMock.confirmInventory).toHaveBeenCalledTimes(1)
    expect(LineItemServiceMock.generate).toHaveBeenCalledTimes(1)
    expect(
      LineItemAdjustmentServiceMock.createAdjustments
    ).toHaveBeenCalledTimes(1)
    expect(TaxProviderServiceMock.createTaxLines).toHaveBeenCalledTimes(1)
    expect(orderItemChangeRepositoryMock.save).toHaveBeenCalledTimes(1)
  })
})
