import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  getInventoryReport,
  getRecipeIngredientBatchDetails,
  getRecipes,
  saveRecipe,
  setRecipeStatus
} from '../controllers/inventoryAdvancedController.js';
import { getInventoryBatches } from '../controllers/inventoryController.js';
import {
  createMenuItem, createOrder, getMenu, settleOrder, updateMenuItem, updateOrderStatus
} from '../controllers/restaurantController.js';
import {
  cancelProductionEntry, createProductionEntry, getProductionDashboard, transferProductionBatch
} from '../controllers/productionController.js';
import {
  FoodOrder, InventoryBalance, InventoryBatch, InventoryItem, InventoryRecipe, InventorySettings,
  MenuCategory, MenuItem, PreparedFoodMovement, ProductionBatch, Property, RecipeConsumption, StockMovement, Unit
} from '../models/index.js';
import {
  consumePreparedFoodForOrder, consumeRecipesForOrder, postStockMovement, recordDirectInventoryUsage,
  recordPreparedFoodUse, runInventoryTransaction
} from '../services/inventoryService.js';
import { setup, teardown } from './setup.js';

const hotelId = new mongoose.Types.ObjectId();
const propertyId = new mongoose.Types.ObjectId();
const actorId = new mongoose.Types.ObjectId();
let gramUnit;
let kilogramUnit;

const requestFor = (overrides = {}) => ({
  hotelId,
  propertyId,
  user: { _id: actorId, role: 'hotel_admin' },
  params: {},
  query: {},
  body: {},
  headers: {},
  socket: {},
  get: () => undefined,
  ...overrides
});

const invoke = async (controller, req) => {
  const res = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
  let error;
  await controller(req, res, (caught) => { error = caught; });
  return { ...res, error };
};

describe('recipe-based inventory management', () => {
  beforeAll(async () => {
    await setup();
    [gramUnit, kilogramUnit] = await Promise.all([
      Unit.create({
        hotelId, name: 'Gram', symbol: 'g', category: 'weight', isStandard: true,
        createdBy: actorId, updatedBy: actorId
      }),
      Unit.create({
        hotelId, name: 'Kilogram', symbol: 'kg', category: 'weight', isStandard: true,
        createdBy: actorId, updatedBy: actorId
      })
    ]);
  });
  afterAll(async () => teardown());

  it('keeps individual and bulk recipe activation separate for the same menu item', async () => {
    const property = await Property.create({
      hotelId,
      name: 'Separate Recipe Modes Property',
      code: `SRM${new mongoose.Types.ObjectId().toString().slice(-5)}`,
      address: '1 Test Road',
      city: 'Test City',
      state: 'Test State',
      phone: '5551234567'
    });
    const category = await MenuCategory.create({ hotelId, name: 'Separate Recipe Modes' });
    const menuItem = await MenuItem.create({
      hotelId,
      categoryId: category._id,
      name: 'Individually Served and Bulk Dish',
      price: 10
    });
    const ingredient = await InventoryItem.create({
      hotelId,
      propertyId: property._id,
      name: 'Separate Mode Ingredient',
      code: `SMI${new mongoose.Types.ObjectId().toString().slice(-5)}`,
      inventoryType: 'raw_material',
      unit: 'kg',
      baseUnit: 'kg',
      currentStock: 10
    });
    const saveModeRecipe = (productionMode, recipeName) => invoke(saveRecipe, requestFor({
      propertyId: property._id,
      body: {
        menuItemId: String(menuItem._id),
        recipeName,
        productionMode,
        expectedProductionYield: productionMode === 'batch_production' ? 10 : 1,
        ingredients: [{ itemId: String(ingredient._id), quantity: 1, unit: 'kg' }]
      }
    }));

    const individualRecipeResponse = await saveModeRecipe('made_to_order', 'Individual Recipe');
    const firstBulkRecipeResponse = await saveModeRecipe('batch_production', 'Bulk Recipe');
    expect(individualRecipeResponse.statusCode).toBe(201);
    expect(firstBulkRecipeResponse.statusCode).toBe(201);

    let activeRecipes = await InventoryRecipe.find({
      menuItemId: menuItem._id,
      isActive: true
    }).lean();
    expect(activeRecipes.map((recipe) => recipe.productionMode).sort()).toEqual([
      'batch_production',
      'made_to_order'
    ]);

    const secondBulkRecipeResponse = await saveModeRecipe('batch_production', 'Updated Bulk Recipe');
    expect(secondBulkRecipeResponse.statusCode).toBe(201);
    activeRecipes = await InventoryRecipe.find({
      menuItemId: menuItem._id,
      isActive: true
    }).lean();
    expect(activeRecipes.map((recipe) => recipe.productionMode).sort()).toEqual([
      'batch_production',
      'made_to_order'
    ]);
    expect(activeRecipes.map((recipe) => recipe.recipeName).sort()).toEqual([
      'Individual Recipe',
      'Updated Bulk Recipe'
    ]);

    const reactivatedIndividual = await invoke(setRecipeStatus, requestFor({
      propertyId: property._id,
      params: { id: String(individualRecipeResponse.body.data._id) },
      body: { isActive: true }
    }));
    expect(reactivatedIndividual.statusCode).toBe(200);
    activeRecipes = await InventoryRecipe.find({
      menuItemId: menuItem._id,
      isActive: true
    }).lean();
    expect(activeRecipes.map((recipe) => recipe.productionMode).sort()).toEqual([
      'batch_production',
      'made_to_order'
    ]);
  });

  it('previews recipe ingredient usage from current batches and includes purchase details', async () => {
    const property = await Property.create({
      hotelId,
      name: 'Recipe Batch Detail Property',
      code: `RBD${new mongoose.Types.ObjectId().toString().slice(-5)}`,
      address: '1 Test Road',
      city: 'Test City',
      state: 'Test State',
      phone: '5551234567'
    });
    const category = await MenuCategory.create({ hotelId, name: 'Recipe Batch Details' });
    const menuItem = await MenuItem.create({
      hotelId,
      categoryId: category._id,
      name: 'Batch Detail Dish',
      price: 12
    });
    const ingredient = await InventoryItem.create({
      hotelId,
      propertyId: property._id,
      name: 'Batch Detail Flour',
      code: `BDF${new mongoose.Types.ObjectId().toString().slice(-5)}`,
      inventoryType: 'raw_material',
      unit: 'kg',
      baseUnit: 'kg',
      unitCost: 6,
      currentStock: 7
    });
    const recipe = await InventoryRecipe.create({
      hotelId,
      propertyId: property._id,
      menuItemId: menuItem._id,
      location: 'Kitchen Store',
      productionMode: 'made_to_order',
      expectedProductionYield: 2,
      version: 1,
      ingredients: [{
        itemId: ingredient._id,
        quantity: 6,
        unit: 'kg',
        conversionFactor: 1,
        baseUnit: 'kg'
      }],
      createdBy: actorId
    });
    await InventoryBatch.create([
      {
        hotelId,
        propertyId: property._id,
        itemId: ingredient._id,
        location: 'Kitchen Store',
        batchNumber: 'FLOUR-001',
        quantity: 2,
        remainingQuantity: 2,
        unitCost: 4,
        purchaseQuantity: 1,
        purchaseUnit: 'bag',
        purchaseUnitCost: 8,
        purchaseAmount: 8,
        receivedAt: new Date('2026-01-01T00:00:00.000Z')
      },
      {
        hotelId,
        propertyId: property._id,
        itemId: ingredient._id,
        location: 'Kitchen Store',
        batchNumber: 'FLOUR-002',
        quantity: 5,
        remainingQuantity: 5,
        unitCost: 5,
        purchaseQuantity: 2,
        purchaseUnit: 'bag',
        purchaseUnitCost: 12.5,
        purchaseAmount: 25,
        receivedAt: new Date('2026-02-01T00:00:00.000Z')
      }
    ]);

    const response = await invoke(getRecipeIngredientBatchDetails, requestFor({
      propertyId: property._id,
      params: { id: String(recipe._id) }
    }));

    expect(response.statusCode).toBe(200);
    expect(response.body.data.ingredients[0]).toMatchObject({
      itemName: ingredient.name,
      recipeQuantity: 6,
      requiredQuantity: 3,
      unit: 'kg',
      baseUnit: 'kg',
      allocations: [
        {
          batchNumber: 'FLOUR-001',
          quantityUsed: 2,
          unitCost: 4,
          totalCost: 8,
          purchaseQuantity: 1,
          purchaseUnit: 'bag',
          purchaseUnitCost: 8,
          purchaseAmount: 8
        },
        {
          batchNumber: 'FLOUR-002',
          quantityUsed: 1,
          unitCost: 5,
          totalCost: 5,
          purchaseQuantity: 2,
          purchaseUnit: 'bag',
          purchaseUnitCost: 12.5,
          purchaseAmount: 25
        }
      ],
      legacyAllocation: null,
      shortageQuantity: 0
    });

    const bulkRecipe = await InventoryRecipe.create({
      hotelId,
      propertyId: property._id,
      menuItemId: menuItem._id,
      location: 'Kitchen Store',
      productionMode: 'batch_production',
      expectedProductionYield: 10,
      version: 2,
      ingredients: [{
        itemId: ingredient._id,
        quantity: 6,
        unit: 'kg',
        conversionFactor: 1,
        baseUnit: 'kg'
      }],
      createdBy: actorId
    });
    const bulkResponse = await invoke(getRecipeIngredientBatchDetails, requestFor({
      propertyId: property._id,
      params: { id: String(bulkRecipe._id) }
    }));
    expect(bulkResponse.body.data.ingredients[0]).toMatchObject({
      recipeQuantity: 6,
      requiredQuantity: 6,
      allocations: [
        { batchNumber: 'FLOUR-001', quantityUsed: 2 },
        { batchNumber: 'FLOUR-002', quantityUsed: 4 }
      ],
      shortageQuantity: 0
    });
  });

  it('applies configured percentage and flat menu discounts and snapshots them on the bill', async () => {
    const property = await Property.create({
      hotelId,
      name: 'Menu Discount Property',
      code: `MDP${new mongoose.Types.ObjectId().toString().slice(-5)}`,
      address: '1 Test Road',
      city: 'Test City',
      state: 'Test State',
      phone: '5551234567'
    });
    const category = await MenuCategory.create({ hotelId, name: 'Menu Discount Items' });
    const invalidDiscount = await invoke(createMenuItem, requestFor({
      body: {
        categoryId: category._id,
        name: 'Invalid Percentage Discount',
        price: 100,
        discountType: 'percentage',
        discountValue: 101
      }
    }));
    expect(invalidDiscount.statusCode).toBe(400);

    const percentageItemResponse = await invoke(createMenuItem, requestFor({
      body: {
        categoryId: category._id,
        name: 'Percentage Discount Dish',
        price: 100,
        nonAcPrice: 100,
        nonAcPricingEnabled: true,
        acPrice: 120,
        acPricingEnabled: true,
        discountType: 'percentage',
        discountValue: 10
      }
    }));
    const flatItemResponse = await invoke(createMenuItem, requestFor({
      body: {
        categoryId: category._id,
        name: 'Flat Discount Dish',
        price: 100,
        nonAcPrice: 100,
        nonAcPricingEnabled: true,
        acPrice: 100,
        acPricingEnabled: true,
        discountType: 'flat',
        discountValue: 15
      }
    }));
    expect(percentageItemResponse.statusCode).toBe(201);
    expect(flatItemResponse.statusCode).toBe(201);

    const orderResponse = await invoke(createOrder, requestFor({
      propertyId: property._id,
      body: {
        orderType: 'takeaway',
        diningType: 'ac',
        discountAmount: 5,
        items: [
          { menuItemId: percentageItemResponse.body.data._id, quantity: 2 },
          { menuItemId: flatItemResponse.body.data._id, quantity: 1 }
        ]
      }
    }));

    expect(orderResponse.statusCode).toBe(201);
    expect(orderResponse.body.data.items.map((item) => item.menuDiscountAmount)).toEqual([24, 15]);
    expect(orderResponse.body.data.items[0]).toMatchObject({
      unitPrice: 120,
      unitPriceSnapshot: 120,
      diningType: 'ac',
      menuDiscountType: 'percentage',
      menuDiscountValue: 10,
      amount: 240
    });
    expect(orderResponse.body.data.items[1]).toMatchObject({
      menuDiscountType: 'flat',
      menuDiscountValue: 15,
      menuDiscountAmount: 15,
      amount: 100
    });
    expect(orderResponse.body.data).toMatchObject({
      subtotal: 340,
      discountAmount: 44,
      manualDiscountAmount: 5,
      taxAmount: 17,
      totalAmount: 313
    });

    await invoke(updateMenuItem, requestFor({
      params: { id: String(percentageItemResponse.body.data._id) },
      body: {
        price: 200,
        nonAcPrice: 200,
        nonAcPricingEnabled: true,
        acPrice: 220,
        acPricingEnabled: true,
        discountType: 'flat',
        discountValue: 50
      }
    }));
    const historicalOrder = await FoodOrder.findById(orderResponse.body.data._id).lean();
    expect(historicalOrder.items[0]).toMatchObject({
      unitPriceSnapshot: 120,
      menuDiscountType: 'percentage',
      menuDiscountValue: 10,
      menuDiscountAmount: 24
    });
    expect(historicalOrder.discountAmount).toBe(44);
    expect(historicalOrder.totalAmount).toBe(313);
  });

  it('deducts recipe ingredients at the configured stage, uses FEFO batches, and reverses cancellation', async () => {
    const property = await Property.create({
      hotelId,
      name: 'Recipe Test Property',
      code: `RCP${new mongoose.Types.ObjectId().toString().slice(-5)}`,
      address: '1 Test Road',
      city: 'Test City',
      state: 'Test State',
      phone: '5551234567'
    });
    const category = await MenuCategory.create({ hotelId, name: 'Test Recipes' });
    const menuItem = await MenuItem.create({
      hotelId,
      categoryId: category._id,
      name: 'Recipe Test Dish',
      price: 5
    });
    const ingredient = await InventoryItem.create({
      hotelId,
      propertyId: property._id,
      name: 'Recipe Test Ingredient',
      code: `RTI${new mongoose.Types.ObjectId().toString().slice(-5)}`,
      inventoryType: 'raw_material',
      unit: 'g',
      baseUnit: 'g',
      baseUnitId: gramUnit._id,
      supportedUnits: [{
        unitId: gramUnit._id,
        unitNameSnapshot: 'Gram',
        unitSymbolSnapshot: 'g',
        conversionFactorToBase: 1
      }],
      currentStock: 0,
      unitCost: 0.01,
      trackExpiry: true
    });
    const firstExpiry = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    const secondExpiry = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
    for (const [expiryDate, batchNumber, quantity] of [
      [firstExpiry, 'FEFO-1', 100],
      [secondExpiry, 'FEFO-2', 500]
    ]) {
      await runInventoryTransaction((session) => postStockMovement({
        hotelId,
        propertyId: property._id,
        itemId: ingredient._id,
        movementType: 'receipt',
        quantity,
        unit: 'g',
        unitCost: 0.01,
        purchaseUnitPrice: 0.01,
        location: 'Restaurant Store',
        expiryDate,
        batchNumber,
        recordedBy: actorId,
        session
      }));
    }

    const recipeResponse = await invoke(saveRecipe, requestFor({
      propertyId: property._id,
      body: {
        menuItemId: String(menuItem._id),
        recipeName: 'Test Dish Recipe',
        description: 'One serving',
        servingSize: '1 plate',
        preparationTimeMinutes: 12,
        ingredients: [{ itemId: String(ingredient._id), quantity: 33, unit: 'g' }]
      }
    }));
    expect(recipeResponse.statusCode).toBe(201);
    const recipeId = recipeResponse.body.data._id;

    const recipes = await invoke(getRecipes, requestFor({ propertyId: property._id }));
    expect(recipes.body.data[0]).toMatchObject({
      recipeName: 'Test Dish Recipe',
      servingSize: '1 plate',
      preparationTimeMinutes: 12,
      estimatedRecipeCost: 0.33,
      totalRecipeCost: 0.33,
      sellingPrice: 5,
      estimatedGrossProfit: 4.67,
      estimatedProfitWhole: 4.67,
      expectedProductionYield: 1,
      expectedPreparationLossQuantity: 0,
      expectedUsableQuantity: 1,
      expectedPreparationLossPercent: 0,
      foodCostPercent: 6.6
    });

    const bulkMenuItem = await MenuItem.create({
      hotelId,
      categoryId: category._id,
      name: 'Bulk Recipe Test Dish',
      price: 5,
      nonAcPrice: 5,
      nonAcPricingEnabled: true,
      acPrice: 7,
      acPricingEnabled: true
    });
    const bulkRecipeResponse = await invoke(saveRecipe, requestFor({
      propertyId: property._id,
      body: {
        menuItemId: String(bulkMenuItem._id),
        recipeName: 'Bulk Dish Recipe',
        servingSize: '3 plates',
        productionMode: 'batch_production',
        expectedProductionYield: 3,
        expectedPreparationLossPercent: 10,
        ingredients: [{ itemId: String(ingredient._id), quantity: 33, unit: 'g' }]
      }
    }));
    expect(bulkRecipeResponse.statusCode).toBe(201);
    const recipesWithBulk = await invoke(getRecipes, requestFor({ propertyId: property._id }));
    const bulkRecipe = recipesWithBulk.body.data.find(
      (recipe) => String(recipe._id) === String(bulkRecipeResponse.body.data._id)
    );
    expect(bulkRecipe).toMatchObject({
      menuItemId: {
        price: 5,
        nonAcPrice: 5,
        nonAcPricingEnabled: true,
        acPrice: 7,
        acPricingEnabled: true
      },
      estimatedRecipeCost: 0.12,
      totalRecipeCost: 0.33,
      sellingPrice: 5,
      diningTypePricing: {
        ac: {
          enabled: true,
          sellingPrice: 7,
          estimatedGrossProfit: 6.88,
          estimatedProfitWhole: 18.57,
          foodCostPercent: 1.71
        },
        nonAc: {
          enabled: true,
          sellingPrice: 5,
          estimatedGrossProfit: 4.88,
          estimatedProfitWhole: 13.17,
          foodCostPercent: 2.4
        }
      },
      expectedProductionYield: 3,
      expectedPreparationLossQuantity: 0.3,
      expectedUsableQuantity: 2.7,
      expectedPreparationLossPercent: 10,
      estimatedGrossProfit: 4.88,
      estimatedProfitWhole: 13.17
    });

    const order = await FoodOrder.create({
      hotelId,
      propertyId: property._id,
      orderNumber: `RCP-${new mongoose.Types.ObjectId().toString().slice(-8)}`,
      items: [{ menuItemId: menuItem._id, name: menuItem.name, quantity: 6, unitPrice: 5, amount: 30 }],
      subtotal: 30,
      totalAmount: 30,
      status: 'preparing',
      createdBy: actorId
    });
    const prepared = await invoke(updateOrderStatus, requestFor({
      propertyId: property._id,
      params: { id: String(order._id) },
      body: { status: 'ready' },
      user: { _id: actorId, role: 'restaurant_staff', propertyId: property._id }
    }));
    expect(prepared.error).toBeUndefined();
    expect(prepared.body.data.status).toBe('ready');

    const movement = await StockMovement.findOne({ orderId: order._id, movementType: 'recipe_consumption' });
    expect(movement.quantity).toBe(198);
    expect(movement.batchAllocations.map((allocation) => String(allocation.batchId))).toEqual(
      (await InventoryBatch.find({ itemId: ingredient._id }).sort({ expiryDate: 1 })).map((batch) => String(batch._id))
    );
    expect((await InventoryBalance.findOne({ itemId: ingredient._id, location: 'Restaurant Store' })).quantity).toBe(402);
    const batchLedger = await invoke(getInventoryBatches, requestFor({
      propertyId: property._id,
      query: { itemId: String(ingredient._id), location: 'Restaurant Store' }
    }));
    expect(batchLedger.body.data.reduce((sum, batch) => sum + batch.consumedProfitablyQuantity, 0)).toBe(198);
    expect(batchLedger.body.data.reduce((sum, batch) => sum + batch.unrecordedConsumptionQuantity, 0)).toBe(0);
    expect(batchLedger.body.data.reduce((sum, batch) => sum + batch.salesRevenue, 0)).toBe(1.98);

    await runInventoryTransaction((session) => consumeRecipesForOrder(order, session));
    expect(await StockMovement.countDocuments({ orderId: order._id, movementType: 'recipe_consumption' })).toBe(1);
    const usage = await invoke(getInventoryReport, requestFor({
      propertyId: property._id,
      query: { type: 'recipe-usage' }
    }));
    expect(usage.body.data).toHaveLength(1);
    expect(usage.body.data[0]).toMatchObject({ itemName: ingredient.name, quantity: 198, menuItemName: menuItem.name });
    const monthlyUsage = await invoke(getInventoryReport, requestFor({
      propertyId: property._id,
      query: { type: 'recipe-monthly-usage' }
    }));
    expect(monthlyUsage.body.data).toHaveLength(1);
    expect(monthlyUsage.body.data[0].month).toMatch(/^\d{4}-\d{2}$/);

    const cancelled = await invoke(updateOrderStatus, requestFor({
      propertyId: property._id,
      params: { id: String(order._id) },
      body: { status: 'cancelled' },
      user: { _id: actorId, role: 'restaurant_staff', propertyId: property._id }
    }));
    expect(cancelled.error).toBeUndefined();
    expect((await RecipeConsumption.findOne({ orderId: order._id })).status).toBe('reversed');
    expect((await InventoryBalance.findOne({ itemId: ingredient._id, location: 'Restaurant Store' })).quantity).toBe(600);
    expect(await StockMovement.countDocuments({ orderId: order._id, movementType: 'sale_reversal' })).toBe(1);
    const reversedBatchLedger = await invoke(getInventoryBatches, requestFor({
      propertyId: property._id,
      query: { itemId: String(ingredient._id), location: 'Restaurant Store' }
    }));
    expect(reversedBatchLedger.body.data.reduce((sum, batch) => sum + batch.consumedProfitablyQuantity, 0)).toBe(0);
    expect(reversedBatchLedger.body.data.reduce((sum, batch) => sum + batch.salesRevenue, 0)).toBe(0);
    expect(reversedBatchLedger.body.data.reduce((sum, batch) => sum + batch.remainingQuantity, 0)).toBe(600);

    const recipeFreeMenuItem = await MenuItem.create({
      hotelId,
      categoryId: category._id,
      name: 'Recipe-free Test Dish',
      price: 4
    });
    const recipeFreeOrder = await FoodOrder.create({
      hotelId,
      propertyId: property._id,
      orderNumber: `RF-${new mongoose.Types.ObjectId().toString().slice(-8)}`,
      items: [{ menuItemId: recipeFreeMenuItem._id, name: recipeFreeMenuItem.name, quantity: 1, unitPrice: 4, amount: 4 }],
      subtotal: 4,
      totalAmount: 4,
      status: 'preparing',
      createdBy: actorId
    });
    const recipeFreeStatus = await invoke(updateOrderStatus, requestFor({
      propertyId: property._id,
      params: { id: String(recipeFreeOrder._id) },
      body: { status: 'ready' },
      user: { _id: actorId, role: 'restaurant_staff', propertyId: property._id }
    }));
    expect(recipeFreeStatus.error).toBeUndefined();
    expect(recipeFreeStatus.body.data.status).toBe('ready');
    expect(await RecipeConsumption.countDocuments({ orderId: recipeFreeOrder._id })).toBe(0);

    await invoke(setRecipeStatus, requestFor({
      propertyId: property._id,
      params: { id: String(recipeId) },
      body: { isActive: false }
    }));
    expect(await InventoryRecipe.findById(recipeId).then((recipe) => recipe.isActive)).toBe(false);
  });

  it('leaves the kitchen order unchanged when recipe stock is insufficient', async () => {
    const property = await Property.create({
      hotelId,
      name: 'Insufficient Recipe Property',
      code: `IRP${new mongoose.Types.ObjectId().toString().slice(-5)}`,
      address: '1 Test Road',
      city: 'Test City',
      state: 'Test State',
      phone: '5551234567'
    });
    const category = await MenuCategory.create({ hotelId, name: 'Insufficient Recipes' });
    const menuItem = await MenuItem.create({ hotelId, categoryId: category._id, name: 'Unavailable Dish', price: 10 });
    const ingredient = await InventoryItem.create({
      hotelId,
      propertyId: property._id,
      name: 'Unavailable Ingredient',
      code: `UI${new mongoose.Types.ObjectId().toString().slice(-6)}`,
      inventoryType: 'raw_material',
      unit: 'g',
      baseUnit: 'g',
      baseUnitId: gramUnit._id,
      supportedUnits: [{
        unitId: gramUnit._id,
        unitNameSnapshot: 'Gram',
        unitSymbolSnapshot: 'g',
        conversionFactorToBase: 1
      }],
      currentStock: 0
    });
    await InventoryRecipe.create({
      hotelId,
      propertyId: property._id,
      menuItemId: menuItem._id,
      version: 1,
      ingredients: [{ itemId: ingredient._id, quantity: 10, unit: 'g', conversionFactor: 1, baseUnit: 'g' }],
      createdBy: actorId
    });
    const order = await FoodOrder.create({
      hotelId,
      propertyId: property._id,
      orderNumber: `IRP-${new mongoose.Types.ObjectId().toString().slice(-8)}`,
      items: [{ menuItemId: menuItem._id, name: menuItem.name, quantity: 1, unitPrice: 10, amount: 10 }],
      subtotal: 10,
      totalAmount: 10,
      status: 'preparing',
      createdBy: actorId
    });

    const result = await invoke(updateOrderStatus, requestFor({
      propertyId: property._id,
      params: { id: String(order._id) },
      body: { status: 'ready' },
      user: { _id: actorId, role: 'restaurant_staff', propertyId: property._id }
    }));
    expect(result.error?.statusCode).toBe(409);
    expect((await FoodOrder.findById(order._id)).status).toBe('preparing');
    expect(await RecipeConsumption.countDocuments({ orderId: order._id })).toBe(0);
  });

  it('uses the served deduction stage when configured and does not affect orders without recipes', async () => {
    const property = await Property.create({
      hotelId,
      name: 'Served Stage Property',
      code: `SSP${new mongoose.Types.ObjectId().toString().slice(-5)}`,
      address: '1 Test Road',
      city: 'Test City',
      state: 'Test State',
      phone: '5551234567'
    });
    await InventorySettings.create({
      hotelId,
      propertyId: property._id,
      verificationIntervalDays: 1,
      recipeDeductionStage: 'served',
      updatedBy: actorId
    });
    const category = await MenuCategory.create({ hotelId, name: 'Served Stage Recipes' });
    const menuItem = await MenuItem.create({ hotelId, categoryId: category._id, name: 'Served Dish', price: 8 });
    const ingredient = await InventoryItem.create({
      hotelId,
      propertyId: property._id,
      name: 'Served Ingredient',
      code: `SI${new mongoose.Types.ObjectId().toString().slice(-6)}`,
      inventoryType: 'raw_material',
      unit: 'g',
      baseUnit: 'g',
      baseUnitId: gramUnit._id,
      supportedUnits: [{
        unitId: gramUnit._id,
        unitNameSnapshot: 'Gram',
        unitSymbolSnapshot: 'g',
        conversionFactorToBase: 1
      }],
      currentStock: 0
    });
    await runInventoryTransaction((session) => postStockMovement({
      hotelId,
      propertyId: property._id,
      itemId: ingredient._id,
      movementType: 'receipt',
      quantity: 100,
      unit: 'g',
      purchaseUnitPrice: 0,
      location: 'Restaurant Store',
      recordedBy: actorId,
      session
    }));
    await InventoryRecipe.create({
      hotelId,
      propertyId: property._id,
      menuItemId: menuItem._id,
      version: 1,
      ingredients: [{ itemId: ingredient._id, quantity: 20, unit: 'g', conversionFactor: 1, baseUnit: 'g' }],
      createdBy: actorId
    });
    const order = await FoodOrder.create({
      hotelId,
      propertyId: property._id,
      orderNumber: `SSP-${new mongoose.Types.ObjectId().toString().slice(-8)}`,
      items: [{ menuItemId: menuItem._id, name: menuItem.name, quantity: 1, unitPrice: 8, amount: 8 }],
      subtotal: 8,
      totalAmount: 8,
      status: 'preparing',
      createdBy: actorId
    });
    const restaurantRequest = (status) => requestFor({
      propertyId: property._id,
      params: { id: String(order._id) },
      body: { status },
      user: { _id: actorId, role: 'restaurant_staff', propertyId: property._id }
    });
    await invoke(updateOrderStatus, restaurantRequest('ready'));
    expect(await RecipeConsumption.countDocuments({ orderId: order._id })).toBe(0);
    await invoke(updateOrderStatus, restaurantRequest('served'));
    expect(await RecipeConsumption.countDocuments({ orderId: order._id, status: 'deducted' })).toBe(1);

    const recipeFreeOrder = await FoodOrder.create({
      hotelId,
      propertyId: property._id,
      orderNumber: `NRC-${new mongoose.Types.ObjectId().toString().slice(-8)}`,
      items: [{ menuItemId: new mongoose.Types.ObjectId(), name: 'Recipe-free item', quantity: 1, unitPrice: 3, amount: 3 }],
      subtotal: 3,
      totalAmount: 3,
      status: 'preparing',
      createdBy: actorId
    });
    const noRecipeResult = await invoke(updateOrderStatus, requestFor({
      propertyId: property._id,
      params: { id: String(recipeFreeOrder._id) },
      body: { status: 'ready' },
      user: { _id: actorId, role: 'restaurant_staff', propertyId: property._id }
    }));
    expect(noRecipeResult.error).toBeUndefined();
    expect(noRecipeResult.body.data.status).toBe('ready');
    expect(await RecipeConsumption.countDocuments({ orderId: recipeFreeOrder._id })).toBe(0);
  });

  it('records batch production once, allocates prepared portions at serving, and keeps wastage separate', async () => {
    const property = await Property.create({
      hotelId,
      name: 'Production Test Property',
      code: `PRD${new mongoose.Types.ObjectId().toString().slice(-5)}`,
      address: '1 Test Road',
      city: 'Test City',
      state: 'Test State',
      phone: '5551234567'
    });
    const category = await MenuCategory.create({ hotelId, name: 'Production Recipes' });
    const menuItem = await MenuItem.create({
      hotelId,
      categoryId: category._id,
      name: 'Batch Production Dish',
      price: 12
    });
    const ingredient = await InventoryItem.create({
      hotelId,
      propertyId: property._id,
      name: 'Production Ingredient',
      code: `PRI${new mongoose.Types.ObjectId().toString().slice(-5)}`,
      inventoryType: 'raw_material',
      unit: 'g',
      baseUnit: 'g',
      baseUnitId: gramUnit._id,
      supportedUnits: [{
        unitId: gramUnit._id,
        unitNameSnapshot: 'Gram',
        unitSymbolSnapshot: 'g',
        conversionFactorToBase: 1
      }],
      currentStock: 0,
      trackExpiry: true
    });
    await runInventoryTransaction((session) => postStockMovement({
      hotelId,
      propertyId: property._id,
      itemId: ingredient._id,
      movementType: 'receipt',
      quantity: 1000,
      unit: 'g',
      unitCost: 0.02,
      purchaseUnitPrice: 0.02,
      location: 'Main Store',
      expiryDate: new Date(Date.now() + 30 * 86400000),
      batchNumber: 'PRODUCTION-INGREDIENT-1',
      recordedBy: actorId,
      session
    }));
    const recipe = await InventoryRecipe.create({
      hotelId,
      propertyId: property._id,
      menuItemId: menuItem._id,
      recipeName: 'Production Dish Recipe',
      productionMode: 'batch_production',
      version: 1,
      ingredients: [{ itemId: ingredient._id, quantity: 10, unit: 'g', conversionFactor: 1, baseUnit: 'g' }],
      createdBy: actorId
    });
    const productionInput = {
      hotelId,
      propertyId: property._id,
      recipeId: recipe._id,
      productionQuantity: 20,
      acceptedQuantity: 18,
      productionMethod: 'recipe_based',
      location: 'Kitchen Store',
      rawMaterialLocation: 'Main Store',
      wastage: [{ itemId: String(ingredient._id), quantity: 5, unit: 'g', reason: 'Trimming' }],
      recordedBy: actorId,
      idempotencyKey: `production-test:${new mongoose.Types.ObjectId()}`
    };
    const productionResponse = await invoke(createProductionEntry, requestFor({
      propertyId: property._id,
      body: productionInput
    }));
    expect(productionResponse.statusCode).toBe(201);
    const production = productionResponse.body.data;
    expect(production.duplicate).toBe(false);
    expect(production.batch.acceptedQuantity).toBe(18);
    expect(production.batch.productionCost).toBe(4);
    expect(production.batch.rawMaterialWastageCost).toBe(0.1);
    expect(production.batch.sellingPrice).toBe(12);
    await MenuItem.findByIdAndUpdate(menuItem._id, { price: 15, nonAcPrice: 15, acPrice: 18 });
    expect((await ProductionBatch.findById(production.batch._id)).sellingPrice).toBe(12);
    await MenuItem.findByIdAndUpdate(menuItem._id, { price: 12, nonAcPrice: null, acPrice: null });
    expect((await InventoryItem.findById(ingredient._id)).currentStock).toBe(795);

    const retry = await invoke(createProductionEntry, requestFor({
      propertyId: property._id,
      body: productionInput
    }));
    expect(retry.statusCode).toBe(200);
    expect(retry.body.data.duplicate).toBe(true);
    expect((await InventoryItem.findById(ingredient._id)).currentStock).toBe(795);

    const secondProductionResponse = await invoke(createProductionEntry, requestFor({
      propertyId: property._id,
      body: {
        ...productionInput,
        productionQuantity: 3,
        acceptedQuantity: 3,
        wastage: [],
        expiryDate: new Date(Date.now() + 86400000),
        idempotencyKey: `production-test:${new mongoose.Types.ObjectId()}`
      }
    }));
    expect(secondProductionResponse.statusCode).toBe(201);
    const secondProduction = secondProductionResponse.body.data;
    expect((await InventoryItem.findById(ingredient._id)).currentStock).toBe(765);

    const menuResponse = await invoke(getMenu, requestFor({
      propertyId: property._id,
      user: { _id: actorId, role: 'restaurant_staff', propertyId: property._id }
    }));
    const bulkMenuProduct = menuResponse.body.data.items.find(
      (item) => String(item._id) === String(menuItem._id)
    );
    expect(bulkMenuProduct).toMatchObject({
      fulfillmentSource: 'batch_production',
      availablePreparedPortions: 21
    });

    const bulkOrderResponse = await invoke(createOrder, requestFor({
      propertyId: property._id,
      user: { _id: actorId, role: 'restaurant_staff', propertyId: property._id },
      body: {
        orderType: 'takeaway',
        items: [{ menuItemId: String(menuItem._id), quantity: 2 }]
      }
    }));
    expect(bulkOrderResponse.statusCode).toBe(201);
    expect(bulkOrderResponse.body.data.items[0].fulfillmentSource).toBe('batch_production');
    expect(bulkOrderResponse.body.data.preparedFoodAllocations).toHaveLength(1);
    expect((await ProductionBatch.findById(production.batch._id)).availableQuantity
      + (await ProductionBatch.findById(secondProduction.batch._id)).availableQuantity).toBe(19);
    expect((await ProductionBatch.findById(production.batch._id)).reservedQuantity
      + (await ProductionBatch.findById(secondProduction.batch._id)).reservedQuantity).toBe(2);
    expect((await ProductionBatch.findById(production.batch._id)).soldQuantity
      + (await ProductionBatch.findById(secondProduction.batch._id)).soldQuantity).toBe(0);
    const cancelBulkOrder = await invoke(updateOrderStatus, requestFor({
      propertyId: property._id,
      params: { id: String(bulkOrderResponse.body.data._id) },
      body: { status: 'cancelled' },
      user: { _id: actorId, role: 'restaurant_staff', propertyId: property._id }
    }));
    expect(cancelBulkOrder.error).toBeUndefined();
    expect((await ProductionBatch.findById(production.batch._id)).availableQuantity
      + (await ProductionBatch.findById(secondProduction.batch._id)).availableQuantity).toBe(21);
    expect((await ProductionBatch.findById(production.batch._id)).reservedQuantity
      + (await ProductionBatch.findById(secondProduction.batch._id)).reservedQuantity).toBe(0);

    const reversibleProduction = await invoke(createProductionEntry, requestFor({
      propertyId: property._id,
      body: {
        ...productionInput,
        productionQuantity: 2,
        acceptedQuantity: 2,
        wastage: [],
        idempotencyKey: `production-test:${new mongoose.Types.ObjectId()}`
      }
    }));
    expect(reversibleProduction.statusCode).toBe(201);
    expect((await InventoryItem.findById(ingredient._id)).currentStock).toBe(745);
    const cancelRequest = () => requestFor({
      propertyId: property._id,
      params: { id: String(reversibleProduction.body.data.batch._id) },
      body: { idempotencyKey: 'cancel-before-use-test' }
    });
    const cancelledProduction = await invoke(cancelProductionEntry, cancelRequest());
    expect(cancelledProduction.error).toBeUndefined();
    expect(cancelledProduction.body.data.batch.status).toBe('cancelled');
    expect((await InventoryItem.findById(ingredient._id)).currentStock).toBe(765);
    const repeatedCancellation = await invoke(cancelProductionEntry, cancelRequest());
    expect(repeatedCancellation.statusCode).toBe(200);
    expect(repeatedCancellation.body.data.duplicate).toBe(true);

    const order = await FoodOrder.create({
      hotelId,
      propertyId: property._id,
      orderNumber: `PRD-${new mongoose.Types.ObjectId().toString().slice(-8)}`,
      items: [
        { menuItemId: menuItem._id, name: menuItem.name, quantity: 2, unitPrice: 11, amount: 22 },
        { menuItemId: menuItem._id, name: menuItem.name, quantity: 3, unitPrice: 10, amount: 30 }
      ],
      subtotal: 52,
      totalAmount: 52,
      status: 'preparing',
      createdBy: actorId
    });
    const cancelledOrder = await FoodOrder.create({
      hotelId,
      propertyId: property._id,
      orderNumber: `PRD-${new mongoose.Types.ObjectId().toString().slice(-8)}`,
      items: [{ menuItemId: menuItem._id, name: menuItem.name, quantity: 1, unitPrice: 12, amount: 12 }],
      subtotal: 12,
      totalAmount: 12,
      status: 'preparing',
      createdBy: actorId
    });
    const cancelledOrderRequest = (status) => requestFor({
      propertyId: property._id,
      params: { id: String(cancelledOrder._id) },
      body: { status },
      user: { _id: actorId, role: 'restaurant_staff', propertyId: property._id }
    });
    await invoke(updateOrderStatus, cancelledOrderRequest('ready'));
    await invoke(updateOrderStatus, cancelledOrderRequest('cancelled'));
    expect((await ProductionBatch.findById(production.batch._id)).availableQuantity).toBe(18);

    const restaurantRequest = (status) => requestFor({
      propertyId: property._id,
      params: { id: String(order._id) },
      body: { status },
      user: { _id: actorId, role: 'restaurant_staff', propertyId: property._id }
    });
    await invoke(updateOrderStatus, restaurantRequest('ready'));
    const served = await invoke(updateOrderStatus, restaurantRequest('served'));
    expect(served.error).toBeUndefined();
    expect(served.body.data.status).toBe('served');
    const orderAllocation = served.body.data.preparedFoodAllocations;
    expect(orderAllocation).toHaveLength(3);
    expect(orderAllocation.reduce((sum, allocation) => sum + allocation.quantity, 0)).toBe(5);
    expect(orderAllocation.filter((allocation) => String(allocation.productionBatchId) === String(secondProduction.batch._id))
      .reduce((sum, allocation) => sum + allocation.quantity, 0)).toBe(3);
    expect((await ProductionBatch.findById(production.batch._id)).availableQuantity).toBe(16);
    expect((await ProductionBatch.findById(secondProduction.batch._id)).availableQuantity).toBe(0);
    const rejectUsedBatchCancellation = await invoke(cancelProductionEntry, requestFor({
      propertyId: property._id,
      params: { id: String(production.batch._id) },
      body: { idempotencyKey: 'cancel-after-sale-test' }
    }));
    expect(rejectUsedBatchCancellation.error?.statusCode).toBe(409);

    const repeatedAllocation = await runInventoryTransaction(async (session) => {
      const currentOrder = await FoodOrder.findById(order._id).session(session);
      return consumePreparedFoodForOrder(currentOrder, session, actorId);
    });
    expect(repeatedAllocation).toHaveLength(3);
    expect((await ProductionBatch.findById(production.batch._id)).soldQuantity).toBe(2);
    expect((await ProductionBatch.findById(secondProduction.batch._id)).soldQuantity).toBe(3);
    expect(await PreparedFoodMovement.countDocuments({
      orderId: order._id,
      movementType: 'sale'
    })).toBe(3);
    const saleMovements = await PreparedFoodMovement.find({ orderId: order._id, movementType: 'sale' }).lean();
    expect(saleMovements.reduce((sum, movement) => sum + movement.salesRevenue, 0)).toBe(0);
    const settledOrder = await invoke(settleOrder, requestFor({
      propertyId: property._id,
      params: { id: String(order._id) },
      body: { paymentMethod: 'cash' },
      user: { _id: actorId, role: 'restaurant_staff', propertyId: property._id }
    }));
    expect(settledOrder.error).toBeUndefined();
    expect(settledOrder.body.data.paymentStatus).toBe('paid');
    const paidSaleMovements = await PreparedFoodMovement.find({
      orderId: order._id,
      movementType: 'sale'
    }).lean();
    expect(paidSaleMovements.reduce((sum, movement) => sum + movement.salesRevenue, 0)).toBe(52);
    const dashboard = await invoke(getProductionDashboard, requestFor({
      propertyId: property._id,
      query: {
        from: new Date(Date.now() - 86400000).toISOString().slice(0, 10),
        to: new Date().toISOString().slice(0, 10)
      }
    }));
    expect(dashboard.error).toBeUndefined();
    expect(dashboard.body.data.totals).toMatchObject({
      acceptedQuantity: 21,
      soldQuantity: 5,
      salesRevenue: 52,
      soldFoodCost: 1.04,
      grossProfit: 50.96,
      foodCostPercent: expect.any(Number)
    });
    expect(dashboard.body.data.batches.find(
      (batch) => String(batch._id) === String(production.batch._id)
    )).toMatchObject({
      productionCost: 4,
      costPerPortion: 0.22
    });

    const insufficientOrder = await FoodOrder.create({
      hotelId,
      propertyId: property._id,
      orderNumber: `PRD-${new mongoose.Types.ObjectId().toString().slice(-8)}`,
      items: [{ menuItemId: menuItem._id, name: menuItem.name, quantity: 17, unitPrice: 12, amount: 204 }],
      subtotal: 204,
      totalAmount: 204,
      status: 'preparing',
      createdBy: actorId
    });
    const insufficientRequest = (status) => requestFor({
      propertyId: property._id,
      params: { id: String(insufficientOrder._id) },
      body: { status },
      user: { _id: actorId, role: 'restaurant_staff', propertyId: property._id }
    });
    await invoke(updateOrderStatus, insufficientRequest('ready'));
    const insufficientServe = await invoke(updateOrderStatus, insufficientRequest('served'));
    expect(insufficientServe.error?.statusCode).toBe(409);
    expect((await FoodOrder.findById(insufficientOrder._id)).status).toBe('ready');
    expect((await ProductionBatch.findById(production.batch._id)).availableQuantity).toBe(16);

    const transferRequest = (key) => requestFor({
      propertyId: property._id,
      params: { id: String(production.batch._id) },
      body: {
        quantity: 4,
        destinationLocation: 'Dining Outlet',
        idempotencyKey: key
      }
    });
    const transfer = await invoke(transferProductionBatch, transferRequest('production-transfer-test'));
    expect(transfer.error).toBeUndefined();
    expect(transfer.statusCode).toBe(201);
    expect(transfer.body.data.sourceBatch.availableQuantity).toBe(12);
    expect(transfer.body.data.targetBatch).toMatchObject({
      availableQuantity: 4,
      location: 'Dining Outlet',
      isTransferBatch: true
    });
    const duplicateTransfer = await invoke(transferProductionBatch, transferRequest('production-transfer-test'));
    expect(duplicateTransfer.statusCode).toBe(200);
    expect(duplicateTransfer.body.data.duplicate).toBe(true);
    expect(await PreparedFoodMovement.countDocuments({
      idempotencyKey: 'production-transfer-test',
      movementType: 'transfer_out'
    })).toBe(1);

    await runInventoryTransaction((session) => recordPreparedFoodUse({
      hotelId,
      propertyId: property._id,
      productionBatchId: production.batch._id,
      movementType: 'wastage',
      quantity: 2,
      reason: 'End-of-day spoilage',
      recordedBy: actorId,
      idempotencyKey: `wastage-test:${new mongoose.Types.ObjectId()}`
    }, session));
    const closedBatch = await ProductionBatch.findById(production.batch._id);
    expect(closedBatch.availableQuantity).toBe(10);
    expect(closedBatch.wastedQuantity).toBe(2);
    expect(await PreparedFoodMovement.countDocuments({ productionBatchId: production.batch._id, movementType: 'wastage' })).toBe(1);
    await runInventoryTransaction((session) => recordPreparedFoodUse({
      hotelId,
      propertyId: property._id,
      productionBatchId: production.batch._id,
      movementType: 'unrecorded_consumption',
      quantity: 1,
      reason: 'Physical count shortfall',
      recordedBy: actorId,
      idempotencyKey: `unrecorded-food-test:${new mongoose.Types.ObjectId()}`
    }, session));
    const reconciledBatch = await ProductionBatch.findById(production.batch._id);
    expect(reconciledBatch.availableQuantity).toBe(9);
    expect(reconciledBatch.unrecordedQuantity).toBe(1);
    expect(await PreparedFoodMovement.findOne({
      productionBatchId: production.batch._id,
      movementType: 'unrecorded_consumption'
    })).toMatchObject({
      quantity: 1,
      unitCost: 0.22,
      totalCost: 0.22,
      reason: 'Physical count shortfall'
    });
    const closingDashboard = await invoke(getProductionDashboard, requestFor({
      propertyId: property._id,
      query: {
        from: new Date(Date.now() - 86400000).toISOString().slice(0, 10),
        to: new Date().toISOString().slice(0, 10)
      }
    }));
    expect(closingDashboard.body.data.totals).toMatchObject({
      acceptedQuantity: 21,
      soldQuantity: 5,
      transferredOutQuantity: 4,
      wastedQuantity: 2,
      unrecordedQuantity: 1,
      unrecordedFoodCost: 0.22,
      availableQuantity: 13
    });
  });

  it('records complimentary raw materials and unrecorded made-to-order menu usage with idempotent stock deductions', async () => {
      const property = await Property.create({
        hotelId,
        name: 'Direct Usage Property',
        code: `DUP${new mongoose.Types.ObjectId().toString().slice(-5)}`,
        address: '1 Test Road',
        city: 'Test City',
        state: 'Test State',
        phone: '5551234567'
      });
      const category = await MenuCategory.create({ hotelId, name: 'Direct Usage' });
      const menuItem = await MenuItem.create({
        hotelId,
        categoryId: category._id,
        name: 'Made-to-order usage dish',
        price: 20
      });
      const ingredient = await InventoryItem.create({
        hotelId,
        propertyId: property._id,
        name: 'Direct Usage Ingredient',
        code: `DUI${new mongoose.Types.ObjectId().toString().slice(-5)}`,
        inventoryType: 'raw_material',
        unit: 'kg',
        baseUnit: 'kg',
        baseUnitId: kilogramUnit._id,
        supportedUnits: [{
          unitId: kilogramUnit._id,
          unitNameSnapshot: 'Kilogram',
          unitSymbolSnapshot: 'kg',
          conversionFactorToBase: 1
        }],
        currentStock: 0,
        unitCost: 10
      });
      await runInventoryTransaction((session) => postStockMovement({
        hotelId,
        propertyId: property._id,
        itemId: ingredient._id,
        movementType: 'receipt',
        quantity: 10,
        unit: 'kg',
        unitCost: 10,
        purchaseUnitPrice: 10,
        location: 'Main Store',
        recordedBy: actorId,
        session
      }));
      const recipe = await InventoryRecipe.create({
        hotelId,
        propertyId: property._id,
        menuItemId: menuItem._id,
        recipeName: 'Made-to-order usage recipe',
        servingSize: 'portion',
        location: 'Main Store',
        expectedProductionYield: 4,
        productionMode: 'made_to_order',
        version: 1,
        ingredients: [{
          itemId: ingredient._id,
          quantity: 2,
          unit: 'kg',
          conversionFactor: 1
        }],
        createdBy: actorId
      });
      const rawUsageKey = `direct-raw:${new mongoose.Types.ObjectId()}`;
      const rawUsage = await runInventoryTransaction((session) => recordDirectInventoryUsage({
        hotelId,
        propertyId: property._id,
        targetType: 'raw_material',
        targetId: ingredient._id,
        usageType: 'complimentary',
        quantity: 1,
        reason: 'Complimentary kitchen use',
        recordedBy: actorId,
        idempotencyKey: rawUsageKey,
        session
      }));
      const duplicateRawUsage = await runInventoryTransaction((session) => recordDirectInventoryUsage({
        hotelId,
        propertyId: property._id,
        targetType: 'raw_material',
        targetId: ingredient._id,
        usageType: 'complimentary',
        quantity: 1,
        reason: 'Complimentary kitchen use',
        recordedBy: actorId,
        idempotencyKey: rawUsageKey,
        session
      }));
      const menuUsage = await runInventoryTransaction((session) => recordDirectInventoryUsage({
        hotelId,
        propertyId: property._id,
        targetType: 'menu_item',
        targetId: recipe._id,
        usageType: 'unrecorded_consumption',
        quantity: 2,
        reason: 'Unrecorded staff meal',
        recordedBy: actorId,
        idempotencyKey: `direct-menu:${new mongoose.Types.ObjectId()}`,
        session
      }));

      expect(rawUsage).toMatchObject({ duplicate: false, totalCost: 10 });
      expect(duplicateRawUsage.duplicate).toBe(true);
      expect(menuUsage).toMatchObject({ duplicate: false, totalCost: 10 });
      expect(menuUsage.usage).toMatchObject({
        usageType: 'unrecorded_consumption',
        targetType: 'menu_item',
        targetName: menuItem.name,
        targetQuantity: 2,
        targetUnit: 'portion'
      });
      expect(menuUsage.movements[0]).toMatchObject({
        quantity: 1,
        totalValue: 10,
        metadata: { source: 'manual_unrecorded_usage' }
      });
      expect((await InventoryItem.findById(ingredient._id)).currentStock).toBe(8);
      expect(await StockMovement.countDocuments({
        hotelId,
        propertyId: property._id,
        'metadata.directUsage.usageId': rawUsageKey
      })).toBe(1);
  });

  it('grosses up recipe ingredient quantities by expected preparation loss for raw materials', async () => {
    const property = await Property.create({
      hotelId,
      name: 'Loss Isolation Property',
      code: `LOS${new mongoose.Types.ObjectId().toString().slice(-5)}`,
      address: '3 Test Road',
      city: 'Test City',
      state: 'Test State',
      phone: '5551234569'
    });
    const category = await MenuCategory.create({ hotelId, name: 'Loss Isolation Recipes' });
    const menuItem = await MenuItem.create({
      hotelId,
      categoryId: category._id,
      name: 'Rice Congee',
      price: 10
    });
    const rice = await InventoryItem.create({
      hotelId,
      propertyId: property._id,
      name: 'Ponni rice',
      code: `RCE${new mongoose.Types.ObjectId().toString().slice(-5)}`,
      inventoryType: 'raw_material',
      unit: 'kg',
      baseUnit: 'kg',
      baseUnitId: kilogramUnit._id,
      supportedUnits: [{
        unitId: kilogramUnit._id,
        unitNameSnapshot: 'Kilogram',
        unitSymbolSnapshot: 'kg',
        conversionFactorToBase: 1
      }],
      currentStock: 0
    });
    await runInventoryTransaction((session) => postStockMovement({
      hotelId,
      propertyId: property._id,
      itemId: rice._id,
      movementType: 'receipt',
      quantity: 10,
      unit: 'kg',
      unitCost: 100,
      purchaseUnitPrice: 100,
      location: 'Main Store',
      recordedBy: actorId,
      session
    }));
    const recipe = await InventoryRecipe.create({
      hotelId,
      propertyId: property._id,
      menuItemId: menuItem._id,
      recipeName: 'Rice /congee',
      productionMode: 'batch_production',
      expectedProductionYield: 10,
      expectedPreparationLossPercent: 7,
      version: 1,
      ingredients: [{ itemId: rice._id, quantity: 2, unit: 'kg', conversionFactor: 1, baseUnit: 'kg' }],
      createdBy: actorId
    });

    // Full batch: required = usable / (1 - loss%) = 2 / 0.93 ≈ 2.15053763 kg.
    const requiredWithLoss = Math.round((2 / (1 - 0.07) + Number.EPSILON) * 100000000) / 100000000;
    const fullBatch = await invoke(createProductionEntry, requestFor({
      propertyId: property._id,
      body: {
        hotelId,
        propertyId: property._id,
        recipeId: recipe._id,
        productionQuantity: 10,
        acceptedQuantity: 10,
        productionMethod: 'recipe_based',
        location: 'Kitchen Store',
        rawMaterialLocation: 'Main Store',
        wastage: [],
        recordedBy: actorId,
        idempotencyKey: `loss-isolation:${new mongoose.Types.ObjectId()}`
      }
    }));
    expect(fullBatch.statusCode).toBe(201);
    expect(fullBatch.body.data.batch.ingredients[0]).toMatchObject({
      theoreticalQuantity: requiredWithLoss,
      actualQuantity: requiredWithLoss,
      wastageQuantity: 0
    });
    expect((await InventoryItem.findById(rice._id)).currentStock).toBeCloseTo(10 - requiredWithLoss, 7);

    // Explicit wastage remains a separate deduction (loss not applied twice).
    const withWastage = await invoke(createProductionEntry, requestFor({
      propertyId: property._id,
      body: {
        hotelId,
        propertyId: property._id,
        recipeId: recipe._id,
        productionQuantity: 10,
        acceptedQuantity: 10,
        productionMethod: 'recipe_based',
        location: 'Kitchen Store',
        rawMaterialLocation: 'Main Store',
        wastage: [{ itemId: String(rice._id), quantity: 0.2, unit: 'kg', reason: 'Spill' }],
        recordedBy: actorId,
        idempotencyKey: `loss-isolation:${new mongoose.Types.ObjectId()}`
      }
    }));
    expect(withWastage.statusCode).toBe(201);
    expect(withWastage.body.data.batch.ingredients[0]).toMatchObject({
      theoreticalQuantity: requiredWithLoss,
      actualQuantity: requiredWithLoss,
      wastageQuantity: 0.2
    });
    expect((await InventoryItem.findById(rice._id)).currentStock).toBeCloseTo(
      10 - requiredWithLoss - requiredWithLoss - 0.2,
      7
    );
    expect(await StockMovement.countDocuments({
      hotelId,
      propertyId: property._id,
      itemId: rice._id,
      movementType: 'wastage'
    })).toBe(1);
  });

  it('calculates full-recipe costs from purchase prices and inventory batches, and reports missing costs as pending', async () => {
    const property = await Property.create({
      hotelId,
      name: 'Recipe Cost Test Property',
      code: `RCT${new mongoose.Types.ObjectId().toString().slice(-5)}`,
      address: '2 Test Road',
      city: 'Test City',
      state: 'Test State',
      phone: '5551234568'
    });
    const category = await MenuCategory.create({ hotelId, name: 'Recipe Cost Tests' });
    const menuItem = await MenuItem.create({
      hotelId,
      categoryId: category._id,
      name: 'Costed Recipe Test Dish',
      price: 20
    });
    const purchasePriceIngredient = await InventoryItem.create({
      hotelId,
      propertyId: property._id,
      name: 'Purchase Price Ingredient',
      code: `PPI${new mongoose.Types.ObjectId().toString().slice(-5)}`,
      inventoryType: 'raw_material',
      unit: 'g',
      baseUnit: 'g',
      // Enough for gross-up: 2g usable @ 20% loss → 2.5g required
      currentStock: 10,
      purchasePrice: 40,
      purchaseConversionFactor: 4,
      unitCost: 0
    });
    const batchCostIngredient = await InventoryItem.create({
      hotelId,
      propertyId: property._id,
      name: 'Batch Cost Ingredient',
      code: `BCI${new mongoose.Types.ObjectId().toString().slice(-5)}`,
      inventoryType: 'raw_material',
      unit: 'g',
      baseUnit: 'g',
      currentStock: 10,
      unitCost: 0
    });
    await InventoryBatch.create([
      {
        hotelId, propertyId: property._id, itemId: batchCostIngredient._id,
        location: 'Main Store', quantity: 1, remainingQuantity: 1, unitCost: 6
      },
      {
        hotelId, propertyId: property._id, itemId: batchCostIngredient._id,
        location: 'Main Store', quantity: 3, remainingQuantity: 3, unitCost: 10
      }
    ]);

    const recipeResponse = await invoke(saveRecipe, requestFor({
      propertyId: property._id,
      body: {
        menuItemId: String(menuItem._id),
        recipeName: 'Costed Recipe',
        expectedProductionYield: 10,
        expectedPreparationLossPercent: 20,
        productionMode: 'batch_production',
        ingredients: [
          { itemId: String(purchasePriceIngredient._id), quantity: 2, unit: 'g' },
          { itemId: String(batchCostIngredient._id), quantity: 2, unit: 'g' }
        ]
      }
    }));
    expect(recipeResponse.statusCode).toBe(201);

    const recipes = await invoke(getRecipes, requestFor({ propertyId: property._id }));
    const recipe = recipes.body.data.find((entry) => String(entry._id) === String(recipeResponse.body.data._id));
    expect(recipe).toMatchObject({
      totalRecipeCost: 38,
      estimatedRecipeCost: 4.75,
      costPerServing: 4.75,
      sellingPrice: 20,
      expectedProductionYield: 10,
      expectedPreparationLossPercent: 20,
      expectedPreparationLossQuantity: 2,
      expectedUsableQuantity: 8,
      estimatedGrossProfit: 15.25,
      estimatedProfitWhole: 122,
      foodCostPercent: 23.75,
      costPending: false
    });

    const production = await invoke(createProductionEntry, requestFor({
      propertyId: property._id,
      body: {
        recipeId: String(recipeResponse.body.data._id),
        productionQuantity: 10,
        acceptedQuantity: 10,
        productionMethod: 'recipe_based',
        location: 'Kitchen Store',
        rawMaterialLocation: 'Main Store',
        idempotencyKey: `recipe-cost-production:${new mongoose.Types.ObjectId()}`
      }
    }));
    expect(production.statusCode).toBe(201);
    // Production deducts grossed-up qty (×1.25 at 20% loss): 38 × 1.25 = 47.5
    expect(production.body.data.batch).toMatchObject({
      productionCost: 47.5,
      costPerPortion: 4.75,
      sellingPrice: 20
    });

    const unpricedMenuItem = await MenuItem.create({
      hotelId,
      categoryId: category._id,
      name: 'Unpriced Recipe Test Dish',
      price: 20
    });
    const unpricedIngredient = await InventoryItem.create({
      hotelId,
      propertyId: property._id,
      name: 'Unpriced Ingredient',
      code: `UPI${new mongoose.Types.ObjectId().toString().slice(-5)}`,
      inventoryType: 'raw_material',
      unit: 'g',
      baseUnit: 'g',
      currentStock: 0,
      unitCost: 0,
      purchasePrice: null
    });
    const unpricedRecipe = await invoke(saveRecipe, requestFor({
      propertyId: property._id,
      body: {
        menuItemId: String(unpricedMenuItem._id),
        ingredients: [{ itemId: String(unpricedIngredient._id), quantity: 1, unit: 'g' }]
      }
    }));
    const recipesWithUnpriced = await invoke(getRecipes, requestFor({ propertyId: property._id }));
    const pendingRecipe = recipesWithUnpriced.body.data.find(
      (entry) => String(entry._id) === String(unpricedRecipe.body.data._id)
    );
    expect(pendingRecipe).toMatchObject({
      totalRecipeCost: null,
      estimatedRecipeCost: null,
      estimatedGrossProfit: null,
      estimatedProfitWhole: null,
      foodCostPercent: null,
      costPending: true
    });

    const missingYieldRecipe = await InventoryRecipe.create({
      hotelId,
      propertyId: property._id,
      menuItemId: unpricedMenuItem._id,
      recipeName: 'Recipe Without Yield',
      servingSize: '1 serving',
      expectedProductionYield: null,
      expectedPreparationLossPercent: 10,
      productionMode: 'made_to_order',
      version: 2,
      ingredients: [{
        itemId: purchasePriceIngredient._id,
        quantity: 2,
        unit: 'g',
        conversionFactor: 1
      }],
      createdBy: actorId
    });
    const recipesWithoutYield = await invoke(getRecipes, requestFor({ propertyId: property._id }));
    const yieldPendingRecipe = recipesWithoutYield.body.data.find(
      (entry) => String(entry._id) === String(missingYieldRecipe._id)
    );
    expect(yieldPendingRecipe).toMatchObject({
      totalRecipeCost: 20,
      estimatedRecipeCost: null,
      expectedPreparationLossQuantity: null,
      expectedUsableQuantity: null,
      estimatedGrossProfit: null,
      estimatedProfitWhole: null,
      foodCostPercent: null
    });
  });
});
