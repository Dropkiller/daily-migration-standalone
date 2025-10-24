import { relations } from "drizzle-orm/relations";
import { product, productAttributes, productFollow, category, categoryMappings, userMemberships, membershipCancellationReasons, communities, featuredProducts, billingAddresses, partners, socials, history, platformConfigurations, platformCredentials, platformHeaders } from "./schema";

export const productAttributesRelations = relations(productAttributes, ({one}) => ({
	product: one(product, {
		fields: [productAttributes.productId],
		references: [product.uuid]
	}),
}));

export const productRelations = relations(product, ({many}) => ({
	productAttributes: many(productAttributes),
	productFollows: many(productFollow),
	featuredProducts: many(featuredProducts),
	histories: many(history),
}));

export const productFollowRelations = relations(productFollow, ({one}) => ({
	product: one(product, {
		fields: [productFollow.productId],
		references: [product.uuid]
	}),
}));

export const categoryMappingsRelations = relations(categoryMappings, ({one}) => ({
	category: one(category, {
		fields: [categoryMappings.categoryId],
		references: [category.uuid]
	}),
}));

export const categoryRelations = relations(category, ({many}) => ({
	categoryMappings: many(categoryMappings),
}));

export const membershipCancellationReasonsRelations = relations(membershipCancellationReasons, ({one}) => ({
	userMembership: one(userMemberships, {
		fields: [membershipCancellationReasons.userId],
		references: [userMemberships.userId]
	}),
}));

export const userMembershipsRelations = relations(userMemberships, ({one, many}) => ({
	membershipCancellationReasons: many(membershipCancellationReasons),
	billingAddress: one(billingAddresses, {
		fields: [userMemberships.billingAddressId],
		references: [billingAddresses.id]
	}),
}));


export const featuredProductsRelations = relations(featuredProducts, ({one}) => ({
	product: one(product, {
		fields: [featuredProducts.productId],
		references: [product.uuid]
	}),
}));

export const billingAddressesRelations = relations(billingAddresses, ({many}) => ({
	userMemberships: many(userMemberships),
}));

export const socialsRelations = relations(socials, ({one}) => ({
	partner: one(partners, {
		fields: [socials.partnerId],
		references: [partners.id]
	}),
}));

export const partnersRelations = relations(partners, ({many}) => ({
	socials: many(socials),
}));

export const historyRelations = relations(history, ({one}) => ({
	product: one(product, {
		fields: [history.externalProductId],
		references: [product.country]
	}),
}));

export const platformCredentialsRelations = relations(platformCredentials, ({one}) => ({
	platformConfiguration: one(platformConfigurations, {
		fields: [platformCredentials.configurationId],
		references: [platformConfigurations.id]
	}),
}));

export const platformConfigurationsRelations = relations(platformConfigurations, ({many}) => ({
	platformCredentials: many(platformCredentials),
	platformHeaders: many(platformHeaders),
}));

export const platformHeadersRelations = relations(platformHeaders, ({one}) => ({
	platformConfiguration: one(platformConfigurations, {
		fields: [platformHeaders.configurationId],
		references: [platformConfigurations.id]
	}),
}));