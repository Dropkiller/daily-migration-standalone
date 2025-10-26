import { pgTable, varchar, timestamp, text, integer, index, uniqueIndex, foreignKey, boolean, doublePrecision, date, pgEnum } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

export const platformType = pgEnum("PlatformType", ['DROPI', 'ALICLICK', 'DROPLATAM', 'SEVENTY_BLOCK'])
export const productStatus = pgEnum("ProductStatus", ['ACTIVE', 'INACTIVE', 'BLOCKED'])


export const prismaMigrations = pgTable("_prisma_migrations", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	checksum: varchar({ length: 64 }).notNull(),
	finishedAt: timestamp("finished_at", { withTimezone: true, mode: 'string' }),
	migrationName: varchar("migration_name", { length: 255 }).notNull(),
	logs: text(),
	rolledBackAt: timestamp("rolled_back_at", { withTimezone: true, mode: 'string' }),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	appliedStepsCount: integer("applied_steps_count").default(0).notNull(),
});

export const platforms = pgTable("platforms", {
	id: text().primaryKey().notNull(),
	name: text().notNull(),
	type: platformType().notNull(),
	createdAt: timestamp("created_at", { precision: 3, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp("updated_at", { precision: 3, mode: 'string' }).notNull(),
});

export const platformCategories = pgTable("platform_categories", {
	id: text().primaryKey().notNull(),
	externalId: text("external_id").notNull(),
	name: text().notNull(),
	platformId: text("platform_id").notNull(),
	baseCategoryId: text("base_category_id").notNull(),
	createdAt: timestamp("created_at", { precision: 3, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp("updated_at", { precision: 3, mode: 'string' }).notNull(),
}, (table) => [
	index("platform_categories_base_category_id_idx").using("btree", table.baseCategoryId.asc().nullsLast().op("text_ops")),
	uniqueIndex("platform_categories_platform_id_name_key").using("btree", table.platformId.asc().nullsLast().op("text_ops"), table.name.asc().nullsLast().op("text_ops")),
	foreignKey({
		columns: [table.platformId],
		foreignColumns: [platforms.id],
		name: "platform_categories_platform_id_fkey"
	}).onUpdate("cascade").onDelete("restrict"),
	foreignKey({
		columns: [table.baseCategoryId],
		foreignColumns: [baseCategories.id],
		name: "platform_categories_base_category_id_fkey"
	}).onUpdate("cascade").onDelete("restrict"),
]);

export const baseCategories = pgTable("base_categories", {
	id: text().primaryKey().notNull(),
	name: text().notNull(),
	createdAt: timestamp("created_at", { precision: 3, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp("updated_at", { precision: 3, mode: 'string' }).notNull(),
}, (table) => [
	uniqueIndex("base_categories_name_key").using("btree", table.name.asc().nullsLast().op("text_ops")),
]);

export const platformCountries = pgTable("platform_countries", {
	id: text().primaryKey().notNull(),
	platformId: text("platform_id").notNull(),
	countryId: text("country_id").notNull(),
	createdAt: timestamp("created_at", { precision: 3, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp("updated_at", { precision: 3, mode: 'string' }).notNull(),
}, (table) => [
	index("platform_countries_country_id_idx").using("btree", table.countryId.asc().nullsLast().op("text_ops")),
	uniqueIndex("platform_countries_platform_id_country_id_key").using("btree", table.platformId.asc().nullsLast().op("text_ops"), table.countryId.asc().nullsLast().op("text_ops")),
	index("platform_countries_platform_id_idx").using("btree", table.platformId.asc().nullsLast().op("text_ops")),
	foreignKey({
		columns: [table.platformId],
		foreignColumns: [platforms.id],
		name: "platform_countries_platform_id_fkey"
	}).onUpdate("cascade").onDelete("restrict"),
	foreignKey({
		columns: [table.countryId],
		foreignColumns: [countries.id],
		name: "platform_countries_country_id_fkey"
	}).onUpdate("cascade").onDelete("restrict"),
]);

export const countries = pgTable("countries", {
	id: text().primaryKey().notNull(),
	name: text().notNull(),
	currency: text().notNull(),
	code: text().notNull(),
	createdAt: timestamp("created_at", { precision: 3, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp("updated_at", { precision: 3, mode: 'string' }).notNull(),
}, (table) => [
	uniqueIndex("countries_code_key").using("btree", table.code.asc().nullsLast().op("text_ops")),
]);

export const providers = pgTable("providers", {
	id: text().primaryKey().notNull(),
	name: text().notNull(),
	externalId: text("external_id").notNull(),
	verified: boolean().default(false).notNull(),
	platformCountryId: text("platform_country_id").notNull(),
	createdAt: timestamp("created_at", { precision: 3, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp("updated_at", { precision: 3, mode: 'string' }).notNull(),
}, (table) => [
	index("providers_external_id_platform_country_id_idx").using("btree", table.externalId.asc().nullsLast().op("text_ops"), table.platformCountryId.asc().nullsLast().op("text_ops")),
	uniqueIndex("providers_external_id_platform_country_id_key").using("btree", table.externalId.asc().nullsLast().op("text_ops"), table.platformCountryId.asc().nullsLast().op("text_ops")),
	index("providers_name_idx").using("btree", table.name.asc().nullsLast().op("text_ops")),
	index("providers_platform_country_id_idx").using("btree", table.platformCountryId.asc().nullsLast().op("text_ops")),
	foreignKey({
		columns: [table.platformCountryId],
		foreignColumns: [platformCountries.id],
		name: "providers_platform_country_id_fkey"
	}).onUpdate("cascade").onDelete("restrict"),
]);

export const products = pgTable("products", {
	id: text().primaryKey().notNull(),
	externalId: text("external_id").notNull(),
	name: text().notNull(),
	description: text(),
	salePrice: doublePrecision("sale_price").notNull(),
	suggestedPrice: doublePrecision("suggested_price").notNull(),
	totalBilling: doublePrecision("total_billing").default(0).notNull(),
	billingLast7Days: doublePrecision("billing_last_7_days").default(0).notNull(),
	billingLast30Days: doublePrecision("billing_last_30_days").default(0).notNull(),
	totalSoldUnits: doublePrecision("total_sold_units").default(0).notNull(),
	soldUnitsLast7Days: doublePrecision("sold_units_last_7_days").default(0).notNull(),
	soldUnitsLast30Days: doublePrecision("sold_units_last_30_days").default(0).notNull(),
	stock: doublePrecision().default(0).notNull(),
	variationsAmount: integer("variations_amount").default(0).notNull(),
	score: integer().default(0).notNull(),
	status: productStatus().default('ACTIVE').notNull(),
	platformCountryId: text("platform_country_id").notNull(),
	baseCategoryId: text("base_category_id").notNull(),
	createdAt: timestamp("created_at", { precision: 3, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp("updated_at", { precision: 3, mode: 'string' }).notNull(),
	providerId: text("provider_id").notNull(),
}, (table) => [
	index("products_base_category_id_idx").using("btree", table.baseCategoryId.asc().nullsLast().op("text_ops")),
	uniqueIndex("products_external_id_platform_country_id_key").using("btree", table.externalId.asc().nullsLast().op("text_ops"), table.platformCountryId.asc().nullsLast().op("text_ops")),
	index("products_name_idx").using("btree", table.name.asc().nullsLast().op("text_ops")),
	index("products_platform_country_id_base_category_id_idx").using("btree", table.platformCountryId.asc().nullsLast().op("text_ops"), table.baseCategoryId.asc().nullsLast().op("text_ops")),
	index("products_platform_country_id_idx").using("btree", table.platformCountryId.asc().nullsLast().op("text_ops")),
	index("products_provider_id_platform_country_id_idx").using("btree", table.providerId.asc().nullsLast().op("text_ops"), table.platformCountryId.asc().nullsLast().op("text_ops")),
	index("products_sale_price_idx").using("btree", table.salePrice.asc().nullsLast().op("float8_ops")),
	index("products_score_idx").using("btree", table.score.asc().nullsLast().op("int4_ops")),
	index("products_status_idx").using("btree", table.status.asc().nullsLast().op("enum_ops")),
	index("products_suggested_price_idx").using("btree", table.suggestedPrice.asc().nullsLast().op("float8_ops")),
	index("products_total_billing_idx").using("btree", table.totalBilling.asc().nullsLast().op("float8_ops")),
	index("products_total_sold_units_idx").using("btree", table.totalSoldUnits.asc().nullsLast().op("float8_ops")),
	foreignKey({
		columns: [table.providerId],
		foreignColumns: [providers.id],
		name: "products_provider_id_fkey"
	}).onUpdate("cascade").onDelete("cascade"),
	foreignKey({
		columns: [table.platformCountryId],
		foreignColumns: [platformCountries.id],
		name: "products_platform_country_id_fkey"
	}).onUpdate("cascade").onDelete("restrict"),
	foreignKey({
		columns: [table.baseCategoryId],
		foreignColumns: [baseCategories.id],
		name: "products_base_category_id_fkey"
	}).onUpdate("cascade").onDelete("restrict"),
]);

export const multimedia = pgTable("multimedia", {
	id: text().primaryKey().notNull(),
	type: text().notNull(),
	url: text(),
	originalUrl: text("original_url"),
	productId: text("product_id").notNull(),
	extracted: boolean().default(false).notNull(),
	createdAt: timestamp("created_at", { precision: 3, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp("updated_at", { precision: 3, mode: 'string' }).notNull(),
}, (table) => [
	index("multimedia_product_id_idx").using("btree", table.productId.asc().nullsLast().op("text_ops")),
	index("multimedia_product_id_type_idx").using("btree", table.productId.asc().nullsLast().op("text_ops"), table.type.asc().nullsLast().op("text_ops")),
	index("multimedia_type_idx").using("btree", table.type.asc().nullsLast().op("text_ops")),
	foreignKey({
		columns: [table.productId],
		foreignColumns: [products.id],
		name: "multimedia_product_id_fkey"
	}).onUpdate("cascade").onDelete("cascade"),
]);

export const productPlatforms = pgTable("product_platforms", {
	id: text().primaryKey().notNull(),
	productId: text("product_id").notNull(),
	platformCountryId: text("platform_country_id").notNull(),
	createdAt: timestamp("created_at", { precision: 3, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp("updated_at", { precision: 3, mode: 'string' }).notNull(),
}, (table) => [
	index("product_platforms_platform_country_id_idx").using("btree", table.platformCountryId.asc().nullsLast().op("text_ops")),
	index("product_platforms_product_id_idx").using("btree", table.productId.asc().nullsLast().op("text_ops")),
	uniqueIndex("product_platforms_product_id_platform_country_id_key").using("btree", table.productId.asc().nullsLast().op("text_ops"), table.platformCountryId.asc().nullsLast().op("text_ops")),
	foreignKey({
		columns: [table.productId],
		foreignColumns: [products.id],
		name: "product_platforms_product_id_fkey"
	}).onUpdate("cascade").onDelete("cascade"),
	foreignKey({
		columns: [table.platformCountryId],
		foreignColumns: [platformCountries.id],
		name: "product_platforms_platform_country_id_fkey"
	}).onUpdate("cascade").onDelete("restrict"),
]);

export const histories = pgTable("histories", {
	id: text().primaryKey().notNull(),
	date: date().default(sql`CURRENT_TIMESTAMP`).notNull(),
	stock: doublePrecision().default(0).notNull(),
	salePrice: doublePrecision("sale_price").default(0).notNull(),
	suggestedPrice: doublePrecision("suggested_price").default(0).notNull(),
	soldUnits: doublePrecision("sold_units").default(0).notNull(),
	soldUnitsLast7Days: doublePrecision("sold_units_last_7_days").default(0).notNull(),
	soldUnitsLast30Days: doublePrecision("sold_units_last_30_days").default(0).notNull(),
	totalSoldUnits: doublePrecision("total_sold_units").default(0).notNull(),
	billing: doublePrecision().default(0).notNull(),
	billingLast7Days: doublePrecision("billing_last_7_days").default(0).notNull(),
	billingLast30Days: doublePrecision("billing_last_30_days").default(0).notNull(),
	totalBilling: doublePrecision("total_billing").default(0).notNull(),
	stockAdjustment: boolean("stock_adjustment").default(false).notNull(),
	productId: text("product_id").notNull(),
	stockAdjustmentReason: text("stock_adjustment_reason"),
	createdAt: timestamp("created_at", { precision: 3, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp("updated_at", { precision: 3, mode: 'string' }).notNull(),
}, (table) => [
	index("histories_date_idx").using("btree", table.date.asc().nullsLast().op("date_ops")),
	index("histories_product_id_date_idx").using("btree", table.productId.asc().nullsLast().op("date_ops"), table.date.asc().nullsLast().op("date_ops")),
	index("histories_product_id_date_sold_units_idx").using("btree", table.productId.asc().nullsLast().op("date_ops"), table.date.asc().nullsLast().op("date_ops"), table.soldUnits.asc().nullsLast().op("float8_ops")),
	index("histories_product_id_idx").using("btree", table.productId.asc().nullsLast().op("text_ops")),
	index("histories_product_id_sale_price_idx").using("btree", table.productId.asc().nullsLast().op("text_ops"), table.salePrice.asc().nullsLast().op("float8_ops")),
	foreignKey({
		columns: [table.productId],
		foreignColumns: [products.id],
		name: "histories_product_id_fkey"
	}).onUpdate("cascade").onDelete("cascade"),
]);

export type Product = typeof products.$inferSelect;
export type InsertProduct = typeof products.$inferInsert;
export type InsertProductPartial = Partial<InsertProduct>;

export type History = typeof histories.$inferSelect;
export type InsertHistory = typeof histories.$inferInsert;
export type InsertHistoryPartial = Partial<InsertHistory>;

export type Provider = typeof providers.$inferSelect;
export type InsertProvider = typeof providers.$inferInsert;
export type InsertProviderPartial = {
	id: string;
	name: string;
	externalId: string;
	platformCountryId?: string;
	updatedAt: string;
	verified?: boolean | undefined;
	createdAt?: string | undefined;
}

export type ProductPlatform = typeof productPlatforms.$inferSelect;
export type InsertProductPlatform = typeof productPlatforms.$inferInsert;
export type InsertProductPlatformPartial = Partial<InsertProductPlatform>;

export type BaseCategory = typeof baseCategories.$inferSelect;
export type InsertBaseCategory = typeof baseCategories.$inferInsert;
export type InsertBaseCategoryPartial = Partial<InsertBaseCategory>;

export type PlatformCategory = typeof platformCategories.$inferSelect;
export type InsertPlatformCategory = typeof platformCategories.$inferInsert;
export type InsertPlatformCategoryPartial = Partial<InsertPlatformCategory>;

export enum PlatformType {
	DROPI = "dropi",
	ALICLICK = "aliclick",
	DROPLATAM = "droplatam", // Marca blanca de dropi
	SEVENTY_BLOCK = "seventy block", // Marca blanca de dropi
	WIMPY = "wimppy", // Marca blanca de dropi
	EASYDROP = "easydrop", // Marca blanca de dropi
}

export const Countries = {
	PY: "PY",
	CO: "CO",
	MX: "MX",
	PA: "PA",
	ES: "ES",
	EC: "EC",
	CL: "CL",
	PE: "PE",
	AR: "AR",
	GT: "GT",
} as const;