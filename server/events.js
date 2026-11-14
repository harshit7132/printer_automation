// Real-time server-sent events for orders and admin updates.
import { EventEmitter } from 'node:events';

export const orderEvents = new EventEmitter();
orderEvents.setMaxListeners(250);

export function emitOrderUpdate(orderId) {
  if (orderId) orderEvents.emit(`order:${orderId}`);
  orderEvents.emit('admin:change');
}

export function emitAdminUpdate() {
  orderEvents.emit('admin:change');
}
