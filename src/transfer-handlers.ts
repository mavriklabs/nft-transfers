import { Transfer, TransferEmitter, TransferEventType } from './types/transfer';
import { OrderItem } from 'models/order-item';
import { Order } from 'models/order';
import { FirestoreOrder } from '@infinityxyz/lib/types/core/OBOrder';
import { getDb } from 'firestore';
import { firestoreConstants } from '@infinityxyz/lib/utils/constants';
import { getCollectionDocId } from '@infinityxyz/lib/utils/firestore';

export type TransferHandlerFn = {
  fn: (transfer: Transfer) => Promise<void> | void;
  name: string;
  throwErrorOnFailure: boolean;
};

export const updateOrdersHandler: TransferHandlerFn = {
  fn: updateOrders,
  name: 'updateOrders',
  throwErrorOnFailure: true
};

export const updateOwnershipHandler: TransferHandlerFn = {
  fn: updateOwnership,
  name: 'updateOwnership',
  throwErrorOnFailure: true
};

export function transferHandler(
  transferEmitter: TransferEmitter,
  handlerFns: TransferHandlerFn[],
  filters: ((transfer: Transfer) => Promise<boolean>)[]
): void {
  transferEmitter.on('transfer', async (transfer) => {
    try {
      for (const filter of filters) {
        const shouldHandle = await filter(transfer);
        if (!shouldHandle) {
          return;
        }
      }

      const results = await Promise.allSettled(
        handlerFns.map(({ fn }) => {
          return fn(transfer);
        })
      );

      let index = 0;
      for (const result of results) {
        const handler = handlerFns[index];
        if (result.status === 'rejected' && handler.throwErrorOnFailure) {
          throw new Error(`${handler.name} failed to handle transfer. ${result.reason}`);
        }
        index += 1;
      }
    } catch (err) {
      console.error(err);
      throw err;
    }
  });
}

export async function updateOrders(transfer: Transfer): Promise<void> {
  const standardizedTransfer =
    transfer.type === TransferEventType.Transfer
      ? transfer
      : {
          ...transfer,
          type: TransferEventType.Transfer,
          from: transfer.to, // treat a revert as a transfer from the to address and to the from address
          to: transfer.from
        };

  const orderItemQueries = Object.values(OrderItem.getImpactedOrderItemsQueries(standardizedTransfer));
  const orderItemRefs = await Promise.all(orderItemQueries.map((query) => query.get()));

  const orderPromises = orderItemRefs
    .flatMap((item) => item.docs)
    .map((item) => {
      const order = item.ref.parent.parent;
      return new Promise<Order>((resolve, reject) => {
        order
          ?.get()
          .then((snap) => {
            const orderData = snap.data() as FirestoreOrder;
            if (orderData) {
              resolve(new Order(orderData));
            } else {
              reject(new Error('Order not found'));
            }
          })
          .catch(reject);
      });
    });

  const orders = await Promise.all(orderPromises);

  console.log(`Found: ${orders.length} orders to update`);

  for (const order of orders) {
    await order.handleTransfer(standardizedTransfer);
  }
}

export function updateOwnership(transfer: Transfer): void {
  const chainId = transfer.chainId;
  const collectionAddress = transfer.address;
  const tokenId = transfer.tokenId;
  const db = getDb();
  const collectionDocId = getCollectionDocId({ chainId, collectionAddress });
  db.collection(firestoreConstants.COLLECTIONS_COLL)
    .doc(collectionDocId)
    .collection(firestoreConstants.COLLECTION_NFTS_COLL)
    .doc(tokenId)
    .set({ owner: transfer.to }, { merge: true })
    .then(() => {
      console.log(`Updated ownership of ${chainId}:${collectionAddress}:${tokenId} to ${transfer.to}`);
    })
    .catch((err) => {
      console.error(`Failed to update ownership of ${chainId}:${collectionAddress}:${tokenId} to ${transfer.to}`);
      console.error(err);
    });
}
