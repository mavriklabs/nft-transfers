import { firestoreConstants } from '@infinityxyz/lib/utils/constants';
import { isOBOrderExpired } from '@infinityxyz/lib/utils/orders';
import { getUsername, infinityDb } from 'firestore';
import { Transfer } from 'types/transfer';
import { OrderType } from './order.types';
import { FirestoreOrderItem, OBOrderStatus } from '@infinityxyz/lib/types/core/OBOrder';

export class OrderItem {
  static readonly OWNER_INHERITS_OFFERS = true;

  static getImpactedOrderItemsQueries(transfer: Transfer): Record<string, FirebaseFirestore.Query<FirestoreOrderItem>> {
    const tokenQuery = infinityDb
      .collectionGroup(firestoreConstants.ORDER_ITEMS_SUB_COLL)
      .where('chainId', '==', transfer.chainId)
      .where('collectionAddress', '==', transfer.address)
      .where('tokenId', '==', transfer.tokenId) as FirebaseFirestore.Query<FirestoreOrderItem>;

    const offers = tokenQuery.where('isSellOrder', '==', false);
    const listings = tokenQuery.where('isSellOrder', '==', true);

    const impactedListings = listings.where('makerAddress', 'in', [transfer.to, transfer.from]);

    let impactedOffers = offers;
    if (!OrderItem.OWNER_INHERITS_OFFERS) {
      impactedOffers = offers.where('takerAddress', '==', transfer.from);
    }

    return {
      offers: impactedOffers,
      listings: impactedListings
    };
  }

  private initialOwner: string;

  private currentOwner: string;

  constructor(
    private orderItem: FirestoreOrderItem,
    private ref: FirebaseFirestore.DocumentReference<FirestoreOrderItem>
  ) {
    this.initialOwner = this._ownerFromOrder;
    this.currentOwner = this.initialOwner;
  }

  get orderStatus(): OBOrderStatus {
    return this.orderItem.orderStatus;
  }

  get type(): OrderType {
    return this.orderItem.isSellOrder ? OrderType.Listing : OrderType.Offer;
  }

  get taker(): string {
    return this.orderItem.takerAddress;
  }

  transferMatches(transfer: Transfer): boolean {
    const correctToken =
      transfer.address === this.orderItem.collectionAddress &&
      transfer.tokenId === this.orderItem.tokenId &&
      transfer.chainId === this.orderItem.chainId;

    /**
     * if the order is a listing, then the order matches if
     * 1. the transfer is to the maker
     * 2. the transfer is from the maker
     */
    if (this.type === OrderType.Listing) {
      return (
        correctToken && (transfer.to === this.orderItem.makerAddress || transfer.from === this.orderItem.makerAddress)
      );
    }

    /**
     * the order is an offer
     *
     * if the order is an offer then the order matches if
     * 1. the transfer is to the taker
     * 2. the new owner inherits the offers on the token
     */
    const newOwnerWillBecomeTaker = OrderItem.OWNER_INHERITS_OFFERS;
    const takerIsGainingTokens = transfer.to === this.orderItem.takerAddress;
    // const takerIsLosingTokens = transfer.from === this.orderItem.takerAddress; // TODO erc1155
    const takerShouldBeUpdated = newOwnerWillBecomeTaker || takerIsGainingTokens;
    return correctToken && takerShouldBeUpdated;
  }

  async transfer(transfer: Transfer): Promise<FirestoreOrderItem> {
    if (!this.transferMatches(transfer)) {
      return this.orderItem;
    }

    if (this.type === OrderType.Offer && OrderItem.OWNER_INHERITS_OFFERS) {
      this.orderItem.takerAddress = transfer.to;
      const takerUsername = await getUsername(transfer.to);
      this.orderItem.takerUsername = takerUsername;
    }
    this.currentOwner = transfer.to;

    const orderStatus = await this.getOrderStatus();
    this.orderItem.orderStatus = orderStatus;

    return this.orderItem;
  }

  save(): Promise<FirebaseFirestore.WriteResult> {
    return this.ref.update(this.orderItem);
  }

  saveViaBatch(batch: FirebaseFirestore.WriteBatch): void {
    batch.update(this.ref, this.orderItem);
  }

  private get _ownerFromOrder(): string {
    if (this.type === OrderType.Offer) {
      return this.orderItem.takerAddress;
    }
    return this.orderItem.makerAddress;
  }

  /**
   * an order is live if the current time is between the start and end time
   */
  private get _isLive(): boolean {
    const now = Date.now();
    const isExpired = isOBOrderExpired(this.orderItem);

    return now >= this.orderItem.startTimeMs && !isExpired;
  }

  private async getOrderStatus(): Promise<OBOrderStatus> {
    if (!this._isLive) {
      return OBOrderStatus.Invalid;
    }

    const currentOwnerQuantity = await this.getCurrentOwnerQuantity();
    const currentOwnerOwnsEnoughTokens = currentOwnerQuantity >= this.orderItem.numTokens;
    let isValidActive: boolean;
    if (this.type === OrderType.Offer) {
      const takerIsCurrentOwner = this.orderItem.takerAddress === this.currentOwner;
      const makerIsTaker = this.orderItem.makerAddress === this.orderItem.takerAddress;
      isValidActive = takerIsCurrentOwner && currentOwnerOwnsEnoughTokens && !makerIsTaker;
    } else {
      const makerIsCurrentOwner = this.orderItem.makerAddress === this.currentOwner;
      isValidActive = makerIsCurrentOwner && currentOwnerOwnsEnoughTokens;
    }

    return isValidActive ? OBOrderStatus.ValidActive : OBOrderStatus.ValidInactive;
  }

  private async getCurrentOwnerQuantity(): Promise<number> {
    return new Promise<number>((resolve) => {
      resolve(1); // TODO this cannot be assumed for erc1155
    });
  }
}
