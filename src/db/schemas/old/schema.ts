import { pgTable, foreignKey, uuid, varchar, uniqueIndex, timestamp, text, index, integer, doublePrecision, boolean, date, numeric, jsonb } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"



export const productAttributes = pgTable("product_attributes", {
	id: uuid().defaultRandom().notNull(),
	name: varchar().notNull(),
	value: varchar().notNull(),
	productId: uuid("product_id").notNull(),
}, (table) => [
	foreignKey({
			columns: [table.productId],
			foreignColumns: [product.uuid],
			name: "product_attributes_product_id_product_uuid_fk"
		}),
]);

export const productFollow = pgTable("product_follow", {
	id: uuid().defaultRandom().notNull(),
	userId: uuid("user_id").notNull(),
	productId: uuid("product_id").notNull(),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("user_product_idx").using("btree", table.userId.asc().nullsLast().op("uuid_ops"), table.productId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.productId],
			foreignColumns: [product.uuid],
			name: "product_follow_product_id_fkey"
		}).onUpdate("cascade").onDelete("restrict"),
]);

export const categoryMappings = pgTable("category_mappings", {
	id: text().notNull(),
	externalCategoryId: text("external_category_id").notNull(),
	categoryId: uuid("category_id").notNull(),
	platform: text().default('dropi').notNull(),
}, (table) => [
	foreignKey({
			columns: [table.categoryId],
			foreignColumns: [category.uuid],
			name: "category_mappings_category_id_fkey"
		}).onUpdate("cascade").onDelete("restrict"),
]);

export const membershipCancellationReasons = pgTable("membership_cancellation_reasons", {
	id: uuid().defaultRandom().notNull(),
	userId: uuid("user_id").notNull(),
	membershipId: varchar("membership_id").notNull(),
	stripeCustomerId: varchar("stripe_customer_id").notNull(),
	subscriptionId: varchar("subscription_id").notNull(),
	cancellationReason: text("cancellation_reason"),
	additionalFeedback: text("additional_feedback"),
	cancelledAt: timestamp("cancelled_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
	foreignKey({
			columns: [table.userId, table.membershipId],
			foreignColumns: [userMemberships.userId, userMemberships.membershipId],
			name: "fk_user_membership"
		}).onUpdate("cascade").onDelete("cascade"),
]);

export const apiCreditUsage = pgTable("api_credit_usage", {
	id: uuid().defaultRandom().notNull(),
	userId: uuid("user_id").notNull(),
	endpoint: varchar().notNull(),
	creditsUsed: integer("credits_used").default(1).notNull(),
	timestamp: timestamp({ withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
	index("idx_api_credit_usage_user_id").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
]);

export const apiCredits = pgTable("api_credits", {
	id: uuid().defaultRandom().notNull(),
	userId: uuid("user_id").notNull(),
	credits: integer().default(0).notNull(),
	tier: varchar().default('free_tier').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
});

export const historyDeletedBackup = pgTable("history_deleted_backup", {
	uuid: uuid(),
	stock: doublePrecision(),
	date: varchar(),
	externalProductId: varchar("external_product_id"),
	salePrice: doublePrecision("sale_price"),
	salesAmount: doublePrecision("sales_amount"),
	soldUnits: doublePrecision("sold_units"),
	stockAdjustment: boolean("stock_adjustment"),
	stockAdjustmentReason: varchar("stock_adjustment_reason"),
	country: varchar(),
	platform: varchar(),
});

export const featuredProducts = pgTable("featured_products", {
	uuid: uuid().defaultRandom().notNull(),
	productId: uuid("product_id").notNull(),
	featuredDate: date("featured_date").default(sql`CURRENT_DATE`).notNull(),
	soldUnits7Days: doublePrecision("sold_units_7_days").notNull(),
	soldUnits30Days: doublePrecision("sold_units_30_days").notNull(),
	createdAt: timestamp("created_at", { mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp("updated_at", { mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	platform: varchar().default('dropi').notNull(),
	country: varchar().notNull(),
	timesFeatured: integer("times_featured").default(1),
}, (table) => [
	index("idx_featured_products_date").using("btree", table.featuredDate.asc().nullsLast().op("date_ops")),
	index("idx_featured_products_platform_country").using("btree", table.platform.asc().nullsLast().op("text_ops"), table.country.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.productId],
			foreignColumns: [product.uuid],
			name: "fk_featured_product"
		}).onDelete("cascade"),
]);

export const communities = pgTable("communities", {
	id: text().notNull(),
	name: text().notNull(),
	description: text().notNull(),
	imgUrl: text("img_url"),
	verified: boolean().default(false).notNull(),
	instagramUrl: text("instagram_url"),
	youtubeUrl: text("youtube_url"),
	tiktokUrl: text("tiktok_url"),
	createdAt: timestamp("created_at", { precision: 3, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp("updated_at", { precision: 3, mode: 'string' }).notNull(),
});

export const category = pgTable("category", {
	uuid: uuid().defaultRandom().notNull(),
	name: varchar().notNull(),
	externalId: varchar("external_id").notNull(),
	show: boolean(),
	platform: varchar({ length: 50 }).default('dropi').notNull(),
	prompt: text(),
}, (table) => [
	index("category_external_id_idx").using("btree", table.externalId.asc().nullsLast().op("text_ops")),
]);

export const gallery = pgTable("gallery", {
	uuid: uuid().defaultRandom().notNull(),
	url: varchar(),
	sourceUrl: varchar("source_url").notNull(),
	externalProductId: varchar("external_product_id").notNull(),
	ownImage: varchar("own_image"),
}, (table) => [
	index("gallery_external_product_id_idx").using("btree", table.externalProductId.asc().nullsLast().op("text_ops")),
]);

export const userMemberships = pgTable("user_memberships", {
	id: uuid().defaultRandom().notNull(),
	userId: uuid("user_id").notNull(),
	whopUserId: varchar("whop_user_id").notNull(),
	membershipId: varchar("membership_id").notNull(),
	productId: varchar("product_id").notNull(),
	planId: varchar("plan_id").notNull(),
	status: varchar().notNull(),
	startDate: date("start_date").notNull(),
	endDate: date("end_date").notNull(),
	lastPaymentDate: date("last_payment_date").notNull(),
	nextPaymentDate: date("next_payment_date"),
	amountPaid: numeric("amount_paid"),
	tier: varchar().notNull(),
	billingAddressId: uuid("billing_address_id").notNull(),
	membershipRangeDuration: integer("membership_range_duration").notNull(),
	whopCountryAccount: text().default('CO').notNull(),
	paymentPlatform: varchar("payment_platform"),
	affiliateUsername: varchar("affiliate_username", { length: 255 }),
	oldUser: boolean("old_user").default(true),
}, (table) => [
	foreignKey({
			columns: [table.billingAddressId],
			foreignColumns: [billingAddresses.id],
			name: "user_memberships_billing_address_id_billing_addresses_id_fk"
		}),
]);

export const billingAddresses = pgTable("billing_addresses", {
	id: uuid().defaultRandom().notNull(),
	name: varchar().notNull(),
	line1: varchar().notNull(),
	line2: varchar().notNull(),
	city: varchar().notNull(),
	state: varchar().notNull(),
	postalCode: varchar("postal_code").notNull(),
	country: varchar(),
});

export const product = pgTable("product", {
	uuid: uuid().defaultRandom().notNull(),
	createdAt: date("created_at").notNull(),
	suggestedPrice: doublePrecision("suggested_price").default(0).notNull(),
	country: varchar().notNull(),
	externalId: varchar("external_id").notNull(),
	name: varchar().notNull(),
	updatedAt: date("updated_at").notNull(),
	categories: jsonb().notNull(),
	salePrice: doublePrecision("sale_price").notNull(),
	gallery: jsonb().notNull(),
	provider: jsonb().notNull(),
	supplierVerified: boolean("supplier_verified").default(false).notNull(),
	totalSalesAmount: doublePrecision("total_sales_amount").default(0).notNull(),
	totalSoldUnits: doublePrecision("total_sold_units").default(0).notNull(),
	salesLast7Days: doublePrecision("sales_last_7_days").default(0).notNull(),
	salesLast30Days: doublePrecision("sales_last_30_days").default(0).notNull(),
	soldUnitsLast7Days: doublePrecision("sold_units_last_7_days").default(0).notNull(),
	soldUnitsLast30Days: doublePrecision("sold_units_last_30_days").default(0).notNull(),
	stock: doublePrecision().default(0).notNull(),
	profit: doublePrecision().default(0).notNull(),
	variationsAmount: doublePrecision("variations_amount").default(0).notNull(),
	platform: varchar().default('dropi').notNull(),
	visible: boolean().default(true).notNull(),
	isFeatured: boolean("is_featured").default(false).notNull(),
	total: integer(),
	description: text(),
	score: integer().default(0).notNull(),
}, (table) => [
	index("product_external_id_idx").using("btree", table.externalId.asc().nullsLast().op("text_ops")),
	index("product_is_featured_platform_country_idx").using("btree", table.isFeatured.asc().nullsLast().op("text_ops"), table.platform.asc().nullsLast().op("bool_ops"), table.country.asc().nullsLast().op("bool_ops")),
	index("product_platform_country_visible_idx").using("btree", table.platform.asc().nullsLast().op("text_ops"), table.country.asc().nullsLast().op("bool_ops"), table.visible.asc().nullsLast().op("bool_ops")),
	index("product_total_sales_amount_platform_country_idx").using("btree", table.totalSalesAmount.asc().nullsLast().op("float8_ops"), table.platform.asc().nullsLast().op("float8_ops"), table.country.asc().nullsLast().op("text_ops")),
]);

export const protectedEndpoints = pgTable("protected_endpoints", {
	id: uuid().defaultRandom().notNull(),
	endpoint: varchar().notNull(),
	method: varchar().notNull(),
	creditsRequired: integer("credits_required").default(1).notNull(),
	description: text(),
	isActive: boolean("is_active").default(true).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
	index("idx_protected_endpoints_endpoint").using("btree", table.endpoint.asc().nullsLast().op("text_ops")),
]);

export const globalHistory = pgTable("global_history", {
	uuid: uuid().defaultRandom().notNull(),
	date: varchar().notNull(),
	data: jsonb().notNull(),
	externalProductId: varchar("external_product_id").notNull(),
	error: varchar(),
	failed: boolean().default(false),
	country: varchar().default('UNKNOWN').notNull(),
	platform: varchar().default('dropi').notNull(),
}, (table) => [
	uniqueIndex("global_history_date_external_product_id_country_platform_key").using("btree", table.date.asc().nullsLast().op("text_ops"), table.externalProductId.asc().nullsLast().op("text_ops"), table.country.asc().nullsLast().op("text_ops"), table.platform.asc().nullsLast().op("text_ops")),
]);

export const partners = pgTable("partners", {
	id: uuid().defaultRandom().notNull(),
	name: varchar({ length: 255 }).notNull(),
	logo: text().notNull(),
	url: text().notNull(),
	description: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
	verified: boolean().default(false),
}, (table) => [
	index("idx_partners_name").using("btree", table.name.asc().nullsLast().op("text_ops")),
]);

export const socials = pgTable("socials", {
	id: uuid().defaultRandom().notNull(),
	partnerId: uuid("partner_id").notNull(),
	name: varchar({ length: 255 }).notNull(),
	url: text().notNull(),
}, (table) => [
	index("idx_socials_partner_id").using("btree", table.partnerId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.partnerId],
			foreignColumns: [partners.id],
			name: "fk_partner"
		}).onDelete("cascade"),
]);

export const loginDates = pgTable("login_dates", {
	id: uuid().default(sql`uuid_generate_v4()`).notNull(),
	tokenId: uuid("token_id").notNull(),
	lastLogin: timestamp("last_login", { mode: 'string' }).notNull(),
	userId: uuid("user_id").notNull(),
});

export const history = pgTable("history", {
	uuid: uuid().defaultRandom().notNull(),
	stock: doublePrecision().notNull(),
	date: varchar().notNull(),
	externalProductId: varchar("external_product_id").notNull(),
	salePrice: doublePrecision("sale_price").default(0).notNull(),
	salesAmount: doublePrecision("sales_amount").default(0).notNull(),
	soldUnits: doublePrecision("sold_units").default(0).notNull(),
	stockAdjustment: boolean("stock_adjustment").default(false),
	stockAdjustmentReason: varchar("stock_adjustment_reason"),
	country: varchar().notNull(),
	platform: varchar().default('dropi').notNull(),
}, (table) => [
	index("history_external_product_id_idx").using("btree", table.externalProductId.asc().nullsLast().op("text_ops")),
	index("idx_history_external_country_platform").using("btree", table.externalProductId.asc().nullsLast().op("text_ops"), table.country.asc().nullsLast().op("text_ops"), table.platform.asc().nullsLast().op("text_ops")),
	index("idx_history_key_date_desc_inc").using("btree", table.externalProductId.asc().nullsLast().op("text_ops"), table.country.asc().nullsLast().op("text_ops"), table.platform.asc().nullsLast().op("text_ops"), table.date.desc().nullsFirst().op("text_ops"), table.uuid.desc().nullsFirst().op("text_ops"), table.salePrice.asc().nullsLast().op("text_ops"), table.salesAmount.asc().nullsLast().op("text_ops"), table.soldUnits.asc().nullsLast().op("text_ops"), table.stock.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.externalProductId, table.country, table.platform],
			foreignColumns: [product.country, product.externalId, product.platform],
			name: "fk_history_product"
		}),
]);

export const tierCredits = pgTable("tier_credits", {
	id: uuid().defaultRandom().notNull(),
	tierName: varchar("tier_name").notNull(),
	credits: integer().default(0).notNull(),
	description: varchar(),
	isActive: boolean("is_active").default(true).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
	index("idx_tier_credits_tier_name").using("btree", table.tierName.asc().nullsLast().op("text_ops")),
]);

export const platformConfigurations = pgTable("platform_configurations", {
	id: uuid().defaultRandom().notNull(),
	country: varchar({ length: 10 }).notNull(),
	targetUrl: varchar("target_url", { length: 500 }).notNull(),
	preLoginUrl: varchar("pre_login_url", { length: 500 }),
	totalProducts: integer("total_products").notNull(),
	apiUrl: varchar("api_url", { length: 500 }).notNull(),
	referrerUrl: varchar("referrer_url", { length: 500 }),
	whiteBrandId: integer("white_brand_id"),
	platform: varchar({ length: 50 }).default('dropi').notNull(),
	active: boolean().default(true).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_platform_configurations_active").using("btree", table.active.asc().nullsLast().op("bool_ops")),
	index("idx_platform_configurations_country").using("btree", table.country.asc().nullsLast().op("text_ops")),
	index("idx_platform_configurations_platform").using("btree", table.platform.asc().nullsLast().op("text_ops")),
]);

export const platformCredentials = pgTable("platform_credentials", {
	id: uuid().defaultRandom().notNull(),
	configurationId: uuid("configuration_id").notNull(),
	email: varchar({ length: 255 }).notNull(),
	password: varchar({ length: 255 }).notNull(),
	active: boolean().default(true).notNull(),
	lastUsed: timestamp("last_used", { withTimezone: true, mode: 'string' }),
	failureCount: integer("failure_count").default(0).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_platform_credentials_active").using("btree", table.active.asc().nullsLast().op("bool_ops")),
	index("idx_platform_credentials_configuration_id").using("btree", table.configurationId.asc().nullsLast().op("uuid_ops")),
	index("idx_platform_credentials_last_used").using("btree", table.lastUsed.asc().nullsLast().op("timestamptz_ops")),
	foreignKey({
			columns: [table.configurationId],
			foreignColumns: [platformConfigurations.id],
			name: "fk_platform_credentials_configuration"
		}).onDelete("cascade"),
]);

export const platformHeaders = pgTable("platform_headers", {
	id: uuid().defaultRandom().notNull(),
	configurationId: uuid("configuration_id").notNull(),
	headerKey: varchar("header_key", { length: 100 }).notNull(),
	headerValue: varchar("header_value", { length: 500 }).notNull(),
	isRequired: boolean("is_required").default(true).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_platform_headers_configuration_id").using("btree", table.configurationId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.configurationId],
			foreignColumns: [platformConfigurations.id],
			name: "fk_platform_headers_configuration"
		}).onDelete("cascade"),
]);


export type OldProduct = typeof product.$inferSelect;
export type OldHistory = typeof history.$inferSelect;
export type OldMembership = typeof userMemberships.$inferSelect;

