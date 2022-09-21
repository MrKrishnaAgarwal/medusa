export const TaxProviderServiceMock = {
  withTransaction: function () {
    return this
  },
  createTaxLines: jest.fn().mockImplementation((order, calculationContext) => {
    return Promise.resolve()
  }),
}
