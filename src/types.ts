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
  subscriptionKey: string;
  label: string;
  theater: string;
  motherSubscriptionId: string;
  settings: Record<string, unknown>;
  isDefault: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SubscriptionEnvelope extends Record<string, unknown> {
  subscriptionKey: string;
  label: string;
  theater: string;
  motherSubscriptionId: string;
  settings: Record<string, unknown>;
  isDefault: boolean;
  isActive: boolean;
  metadata: Record<string, unknown>;
  fields: unknown[];
  status: Record<string, unknown>;
}

export interface EventRecord {
  subscriptionKey: string;
  event: JeeroEvent;
  createdAt: string;
  updatedAt: string;
}

export interface LogRecord {
  inboxId: string;
  subscriptionKey: string;
  subscriptionId: string;
  action: string;
  message: string;
  createdAt: string;
  updatedAt: string;
}

export interface TicketSnapshotRecord {
  subscriptionKey: string;
  snapshotDate: string;
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
  subscription?: string;
  from?: string;
  to?: string;
  date?: string;
  status?: string;
  theater?: string;
  category?: string;
  query?: string;
  page?: number;
  limit?: number;
}

export interface PaginatedEventsResult {
  total: number;
  page: number;
  limit: number;
  events: EventRecord[];
}

export interface TicketSnapshotsFilter {
  subscription?: string;
  date?: string;
  from?: string;
  to?: string;
  ref?: string;
  query?: string;
  limit?: number;
}
