import { ROLES } from '../config/constants.js';

const ACTIONS = ['view', 'read', 'create', 'update', 'delete'];

export const PERMISSION_MODULES = [
  { key: 'dashboard', label: 'Dashboard', paths: ['/reports/dashboard'] },
  { key: 'frontdesk', label: 'Front Desk', paths: [] },
  { key: 'reservations', label: 'Reservations', paths: ['/reservations'] },
  { key: 'rooms', label: 'Rooms & Rates', paths: ['/rooms', '/room-types'] },
  { key: 'guests', label: 'Guest Directory', paths: ['/guests'] },
  { key: 'billing', label: 'Billing & Invoices', paths: ['/billing'] },
  { key: 'housekeeping', label: 'Housekeeping', paths: ['/housekeeping'] },
  { key: 'restaurant', label: 'Restaurant POS', paths: ['/restaurant'] },
  { key: 'restaurant_pos', label: 'Restaurant POS & Orders', paths: ['/restaurant/orders', '/restaurant/tables'] },
  { key: 'restaurant_billing', label: 'Restaurant Billing & Reports', paths: ['/restaurant/billing-history'] },
  { key: 'menu_management', label: 'Menu Management', paths: ['/restaurant/categories', '/restaurant/items', '/restaurant/menu'] },
  { key: 'inventory', label: 'Inventory & Stock', paths: ['/inventory'] },
  { key: 'inventory_dashboard', label: 'Inventory Dashboard & Reports', paths: ['/inventory/dashboard', '/inventory/reports'] },
  { key: 'raw_materials', label: 'Raw Materials & Purchasing', paths: ['/inventory/raw-materials', '/inventory/items', '/inventory/units', '/inventory/purchase-orders', '/inventory/vendors', '/inventory/goods-receipts', '/inventory/department-requests'] },
  { key: 'procurement', label: 'Procurement Workspace', paths: ['/procurement'] },
  { key: 'procurement_suppliers', label: 'Supplier Master', paths: ['/inventory/procurement/suppliers'] },
  { key: 'procurement_requests', label: 'Purchase Requisitions', paths: ['/inventory/procurement/requisitions'] },
  { key: 'procurement_orders', label: 'Purchase Orders', paths: ['/inventory/procurement/orders'] },
  { key: 'quality_inspection', label: 'Goods Receipt Inspection', paths: ['/inventory/procurement/receipts'] },
  { key: 'procurement_invoices', label: 'Supplier Invoices', paths: ['/inventory/procurement/invoices'] },
  { key: 'procurement_returns', label: 'Supplier Returns', paths: ['/inventory/procurement/returns'] },
  { key: 'procurement_payments', label: 'Supplier Payments', paths: ['/inventory/procurement/payments'] },
  { key: 'procurement_reports', label: 'Procurement Reports', paths: ['/inventory/procurement/reports', '/inventory/procurement/dashboard'] },
  { key: 'stock_verification', label: 'Stock & Verification', paths: ['/inventory/verifications', '/inventory/adjustments', '/inventory/ledger', '/inventory/movements', '/inventory/transfers'] },
  { key: 'restaurant_recipes', label: 'Recipe Management', paths: ['/inventory/recipes'] },
  { key: 'food_production', label: 'Food Production & Closing', paths: ['/inventory/production', '/inventory/usage'] },
  { key: 'storage_locations', label: 'Storage Locations', paths: ['/inventory/storage-locations', '/inventory/storage-location-types', '/inventory/locations'] },
  { key: 'maintenance', label: 'Maintenance', paths: ['/maintenance'] },
  { key: 'expenses', label: 'Expenses', paths: ['/expenses'] },
  { key: 'staff', label: 'Staff Directory', paths: ['/staff/assignees'] },
  { key: 'staff_directory', label: 'Staff & Payroll', paths: ['/staff'] },
  { key: 'payroll', label: 'Payroll & Advances', paths: ['/staff/salary', '/staff/advances'] },
  { key: 'attendance_management', label: 'Attendance Management', paths: ['/staff/attendance'] },
  { key: 'staff_self', label: 'My Attendance', paths: ['/staff/attendance/me', '/staff/attendance/check-in', '/staff/attendance/check-out'] },
  { key: 'shifts', label: 'Shift Rosters', paths: ['/staff/shifts'] },
  { key: 'roles_responsibilities', label: 'Roles & Responsibilities', paths: ['/staff/permissions'] },
  { key: 'leave', label: 'Leave Management', paths: ['/leave'] },
  { key: 'reports', label: 'Reports & Analytics', paths: ['/reports'] },
  { key: 'ai_assistant', label: 'AI Revenue Intel', paths: ['/ai'] },
  { key: 'notifications', label: 'Notifications', paths: ['/notifications'] },
  { key: 'settings', label: 'Hotel Settings', paths: ['/hotels', '/properties'] },
];

export const PERMISSION_ACTIONS = ACTIONS;
export const PERMISSION_KEYS = PERMISSION_MODULES.flatMap(({ key }) => (
  ACTIONS.map((action) => `${key}.${action}`)
));

const fullPermissions = PERMISSION_KEYS;
const permissionsFor = (...modules) => modules.flatMap((module) => {
  const [key, ...actions] = module.split(':');
  const grantedActions = new Set(actions.length ? actions : ACTIONS);
  if (grantedActions.has('view')) grantedActions.add('read');
  return [...grantedActions].map((action) => `${key}.${action}`);
});

const restaurantStaffDefaults = (...modules) => permissionsFor(
  'notifications:view:update',
  'leave:view:create:update',
  'staff_self:view:create:update',
  ...modules
);

export const DEFAULT_ROLE_PERMISSIONS = {
  [ROLES.HOTEL_ADMIN]: fullPermissions,
  [ROLES.RECEPTIONIST]: [
    ...permissionsFor(
      'frontdesk:view',
      'reservations:view:create:update', 'rooms:view',
      'guests:view:create:update', 'billing:view:create:update',
      'housekeeping:view:create:update', 'notifications:view:update',
      'leave:view:create:update', 'staff:view',
      'staff_self:view:create:update'
    ),
  ],
  [ROLES.RESTAURANT_STAFF]: [
    ...permissionsFor(
      'restaurant:view:create:update', 'menu_management:view',
      'inventory:view:create:update', 'notifications:view:update',
      'leave:view:create:update', 'staff:view',
      'staff_self:view:create:update',
      'restaurant_pos:view:create:update',
      'inventory_dashboard:view',
      'raw_materials:view:create:update',
      'stock_verification:view:create:update',
      'restaurant_recipes:view:create:update',
      'food_production:view:create:update'
    )
  ],
  [ROLES.RESTAURANT_MANAGER]: restaurantStaffDefaults(
    'procurement:view',
    'restaurant_pos:view:create:update',
    'restaurant_billing:view:create:update',
    'menu_management:view:create:update',
    'inventory_dashboard:view',
    'raw_materials:view:create:update',
    'stock_verification:view:create:update',
    'restaurant_recipes:view:create:update',
    'food_production:view:create:update',
    'storage_locations:view',
    'procurement_requests:view:create:update',
    'procurement_orders:view:create:update',
    'quality_inspection:view:create:update',
    'procurement_suppliers:view:create:update',
    'procurement_invoices:view',
    'procurement_returns:view:create:update',
    'procurement_reports:view'
  ),
  [ROLES.CASHIER]: restaurantStaffDefaults(
    'restaurant_pos:view:create:update',
    'restaurant_billing:view:create:update',
    'menu_management:view'
  ),
  [ROLES.WAITER]: restaurantStaffDefaults(
    'restaurant_pos:view:create:update',
    'menu_management:view'
  ),
  [ROLES.HEAD_CHEF]: restaurantStaffDefaults(
    'restaurant_pos:view:update',
    'menu_management:view',
    'raw_materials:view',
    'stock_verification:view:create',
    'restaurant_recipes:view:create:update',
    'food_production:view:create:update'
  ),
  [ROLES.SOUS_CHEF]: restaurantStaffDefaults(
    'restaurant_pos:view:update',
    'menu_management:view',
    'raw_materials:view',
    'stock_verification:view:create',
    'restaurant_recipes:view',
    'food_production:view:create:update'
  ),
  [ROLES.COOK]: restaurantStaffDefaults(
    'restaurant_pos:view:update',
    'restaurant_recipes:view',
    'food_production:view'
  ),
  [ROLES.STOREKEEPER]: restaurantStaffDefaults(
    'procurement:view',
    'inventory_dashboard:view',
    'raw_materials:view:create:update',
    'stock_verification:view:create:update',
    'restaurant_recipes:view',
    'food_production:view',
    'storage_locations:view',
    'procurement_orders:view',
    'procurement_requests:view:create',
    'quality_inspection:view:create:update',
    'procurement_returns:view:create'
  ),
  [ROLES.STEWARD]: restaurantStaffDefaults(
    'restaurant_pos:view',
    'inventory_dashboard:view',
    'raw_materials:view',
    'stock_verification:view:create'
  ),
  [ROLES.PURCHASE_MANAGER]: restaurantStaffDefaults(
    'procurement:view',
    'procurement_requests:view:update',
    'procurement_orders:view:create:update',
    'procurement_suppliers:view:create:update',
    'procurement_returns:view:create:update',
    'procurement_reports:view',
    'raw_materials:view'
  ),
  [ROLES.ACCOUNTANT]: restaurantStaffDefaults(
    'procurement:view',
    'quality_inspection:view',
    'procurement_invoices:view:create:update',
    'procurement_payments:view:create:update',
    'procurement_suppliers:view',
    'procurement_reports:view',
    'raw_materials:view'
  ),
  [ROLES.RESTAURANT_RECEPTIONIST]: restaurantStaffDefaults(
    'restaurant_pos:view:create:update',
    'menu_management:view',
    'restaurant_billing:view'
  ),
  [ROLES.HOUSEKEEPING_STAFF]: [
    ...permissionsFor(
      'housekeeping:view:create:update', 'rooms:view',
      'inventory:view:create',
      'maintenance:view', 'notifications:view:update',
      'leave:view:create:update', 'staff:view',
      'staff_self:view:create:update'
    )
  ],
  [ROLES.MAINTENANCE_STAFF]: [
    ...permissionsFor(
      'maintenance:view:create:update',
      'inventory:view:create',
      'notifications:view:update', 'leave:view:create:update',
      'staff:view', 'staff_self:view:create:update'
    )
  ]
};

export const getPermissionOverrides = (user) => {
  const overrides = user?.permissionOverrides;
  if (!overrides) return {};
  if (overrides instanceof Map) return Object.fromEntries(overrides);
  if (typeof overrides.toObject === 'function') return overrides.toObject();
  return overrides;
};

export const hasPermission = (user, permissionKey) => {
  if (!user || !PERMISSION_KEYS.includes(permissionKey)) return false;
  if (user.role === ROLES.SUPER_ADMIN || user.role === ROLES.HOTEL_ADMIN) return true;
  const overrides = getPermissionOverrides(user);
  if (Object.hasOwn(overrides, permissionKey)) return overrides[permissionKey] === true;
  const [module, action] = permissionKey.split('.');
  if (action === 'read') {
    const viewKey = `${module}.view`;
    if (Object.hasOwn(overrides, viewKey)) return overrides[viewKey] === true;
    return (DEFAULT_ROLE_PERMISSIONS[user.role] || []).includes(permissionKey)
      || (DEFAULT_ROLE_PERMISSIONS[user.role] || []).includes(viewKey);
  }
  if (module === 'reservations' || module === 'rooms') {
    const frontDeskKey = `frontdesk.${action}`;
    if (Object.hasOwn(overrides, frontDeskKey)) return overrides[frontDeskKey] === true;
    if ((DEFAULT_ROLE_PERMISSIONS[user.role] || []).includes(frontDeskKey)) return true;
  }
  return (DEFAULT_ROLE_PERMISSIONS[user.role] || []).includes(permissionKey);
};

export const hasExplicitPermission = (user, permissionKey) => (
  getPermissionOverrides(user)[permissionKey] === true
);

export const getEffectivePermissions = (user) => Object.fromEntries(
  PERMISSION_KEYS.map((key) => [key, hasPermission(user, key)])
);

export const getRequestPermissionKey = (req) => {
  const routePrefix = String(req.baseUrl || '')
    .replace(/^\/api\/v1/, '')
    .replace(/\/+$/, '');
  const routePath = `${routePrefix}${req.path || ''}`.replace(/\/+/g, '/');
  if (/^\/staff\/[^/]+\/permissions\/?$/.test(routePath)) return 'roles_responsibilities.update';
  if (/^\/restaurant\/menu\/?$/.test(routePath)) {
    return String(req.method || 'GET').toUpperCase() === 'GET'
      ? 'menu_management.read'
      : 'menu_management.update';
  }
  const module = [...PERMISSION_MODULES]
    .sort((left, right) => (
      Math.max(0, ...right.paths.map((path) => path.length))
      - Math.max(0, ...left.paths.map((path) => path.length)))
    )
    .find(({ paths }) => paths.some((path) => routePath === path || routePath.startsWith(`${path}/`)));
  if (!module) return null;

  const method = String(req.method || 'GET').toUpperCase();
  let action = method === 'GET' || method === 'HEAD' ? 'read'
    : method === 'POST' ? 'create'
      : method === 'DELETE' ? 'delete'
        : 'update';
  if (method === 'POST' && /\/(accept|reject|assign|check-in|check-out|review|status|settle|transfer-to-folio|read|mark-read)(\/|$)/i.test(routePath)) {
    action = 'update';
  }
  return `${module.key}.${action}`;
};

export const isValidPermissionOverride = (overrides) => (
  overrides !== null
  && typeof overrides === 'object'
  && !Array.isArray(overrides)
  && Object.entries(overrides).every(([key, value]) => (
    PERMISSION_KEYS.includes(key) && typeof value === 'boolean'
  ))
);
