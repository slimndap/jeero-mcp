export interface JeeroPrice {
  title: string;
  amount: string;
}

export interface JeeroTickets {
  url?: string;
  total?: number;
  available?: number;
}

export interface JeeroVenue extends Record<string, unknown> {
  title?: string;
  city?: string;
}

export interface JeeroProduction extends Record<string, unknown> {
  ref: string;
  title: string;
  description?: string;
  img?: string;
  categories?: string[];
}

export interface JeeroEvent {
  ref: string;
  start: string;
  end?: string;
  tickets?: JeeroTickets;
  prices?: JeeroPrice[];
  venue?: JeeroVenue;
  status?: string;
  production: JeeroProduction;
  custom?: Record<string, unknown>;
}

export interface StoredSubscription {
  id: number;
  motherSubscriptionId: string;
  settings: Record<string, unknown>;
  siteKey: string;
  siteIdentifier: string;
  createdAt: string;
  updatedAt: string;
}

export interface SubscriptionEnvelope extends Record<string, unknown> {
  motherSubscriptionId: string;
  settings: Record<string, unknown>;
  metadata: Record<string, unknown>;
  fields: unknown[];
  status: Record<string, unknown>;
}

export interface EventRecord {
  theater: string;
  event: JeeroEvent;
  createdAt: string;
  updatedAt: string;
}

export interface LogRecord {
  inboxId: string;
  subscriptionId: string;
  theater: string;
  action: string;
  message: string;
  createdAt: string;
  updatedAt: string;
}

export interface TicketSnapshotRecord {
  snapshotDate: string;
  theater: string;
  ref: string;
  start?: string;
  productionTitle: string;
  totalTickets: number;
  availableTickets: number;
  soldTickets: number;
  createdAt: string;
  updatedAt: string;
}

export interface EventsFilter {
  from?: string;
  to?: string;
  date?: string;
  status?: string;
  theater?: string;
  query?: string;
  limit?: number;
}

export interface TicketSnapshotsFilter {
  date?: string;
  from?: string;
  to?: string;
  theater?: string;
  ref?: string;
  query?: string;
  limit?: number;
}
