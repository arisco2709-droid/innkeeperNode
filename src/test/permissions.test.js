import { describe, expect, it, vi } from 'vitest';
import { ROLES } from '../config/constants.js';
import { authorizeRoles } from '../middlewares/auth.js';
import {
  DEFAULT_ROLE_PERMISSIONS,
  getRequestPermissionKey,
  hasPermission
} from '../services/permissions.js';

describe('staff module permissions', () => {
  it('provides scoped defaults for restaurant roles', () => {
    const cashier = { role: ROLES.CASHIER };
    const chef = { role: ROLES.HEAD_CHEF };

    expect(hasPermission(cashier, 'restaurant_pos.create')).toBe(true);
    expect(hasPermission(cashier, 'restaurant_billing.read')).toBe(true);
    expect(hasPermission(cashier, 'raw_materials.read')).toBe(false);
    expect(hasPermission(chef, 'restaurant_recipes.update')).toBe(true);
    expect(hasPermission(chef, 'restaurant_billing.read')).toBe(false);
  });

  it('supports cannot-view, view-only, read, and write overrides', () => {
    const role = ROLES.WAITER;
    const module = 'restaurant_pos';
    const withOverrides = (access) => ({
      role,
      permissionOverrides: {
        [`${module}.view`]: access !== 'none',
        [`${module}.read`]: ['read', 'write'].includes(access),
        [`${module}.create`]: access === 'write',
        [`${module}.update`]: access === 'write',
        [`${module}.delete`]: false
      }
    });

    expect(hasPermission(withOverrides('none'), `${module}.view`)).toBe(false);
    expect(hasPermission(withOverrides('view_only'), `${module}.view`)).toBe(true);
    expect(hasPermission(withOverrides('view_only'), `${module}.read`)).toBe(false);
    expect(hasPermission(withOverrides('read'), `${module}.read`)).toBe(true);
    expect(hasPermission(withOverrides('read'), `${module}.create`)).toBe(false);
    expect(hasPermission(withOverrides('write'), `${module}.update`)).toBe(true);
    expect(hasPermission(withOverrides('write'), `${module}.delete`)).toBe(false);
  });

  it('keeps legacy view overrides readable unless read is explicitly denied', () => {
    expect(hasPermission({
      role: ROLES.RECEPTIONIST,
      permissionOverrides: { 'rooms.view': true }
    }, 'rooms.read')).toBe(true);
    expect(hasPermission({
      role: ROLES.RECEPTIONIST,
      permissionOverrides: { 'rooms.view': true, 'rooms.read': false }
    }, 'rooms.read')).toBe(false);
  });

  it('maps API requests to the matching module and action', () => {
    const permissionFor = (baseUrl, path, method) => getRequestPermissionKey({ baseUrl, path, method });

    expect(permissionFor('/api/v1/restaurant', '/items', 'POST')).toBe('menu_management.create');
    expect(permissionFor('/api/v1/restaurant', '/orders', 'GET')).toBe('restaurant_pos.read');
    expect(permissionFor('/api/v1/inventory', '/raw-materials/42', 'PATCH')).toBe('raw_materials.update');
    expect(permissionFor('/api/v1/inventory', '/production', 'POST')).toBe('food_production.create');
    expect(permissionFor('/api/v1/inventory', '/transfers', 'POST')).toBe('stock_verification.create');
    expect(permissionFor('/api/v1/inventory', '/storage-location-types', 'GET')).toBe('storage_locations.read');
    expect(permissionFor('/api/v1/inventory', '/procurement/requisitions', 'POST')).toBe('procurement_requests.create');
    expect(permissionFor('/api/v1/inventory', '/procurement/invoices/123/approve', 'PATCH')).toBe('procurement_invoices.update');
  });

  it('grants procurement workspace access only to roles with procurement responsibilities', () => {
    expect(hasPermission({ role: ROLES.RESTAURANT_MANAGER }, 'procurement.view')).toBe(true);
    expect(hasPermission({ role: ROLES.STOREKEEPER }, 'procurement_orders.read')).toBe(true);
    expect(hasPermission({ role: ROLES.ACCOUNTANT }, 'quality_inspection.read')).toBe(true);
    expect(hasPermission({ role: ROLES.CASHIER }, 'procurement.view')).toBe(false);
  });

  it('gives hotel administrators every configured action', () => {
    const admin = {
      role: ROLES.HOTEL_ADMIN,
      permissionOverrides: { 'restaurant_pos.create': false }
    };

    expect(DEFAULT_ROLE_PERMISSIONS[ROLES.HOTEL_ADMIN]).toContain('restaurant_pos.delete');
    expect(hasPermission(admin, 'restaurant_pos.create')).toBe(true);
  });

  it('does not let a module permission bypass admin-only routes', () => {
    const middleware = authorizeRoles(ROLES.HOTEL_ADMIN);
    const req = { user: { role: ROLES.WAITER, permissionOverrides: { 'roles_responsibilities.update': true } } };
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn()
    };
    const next = vi.fn();

    middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});
