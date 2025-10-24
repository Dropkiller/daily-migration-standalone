import { relations } from "drizzle-orm/relations";
import { platforms, platformCategories, baseCategories, platformCountries, countries, providers, products, multimedia, productPlatforms, histories } from "./schema";

export const platformCategoriesRelations = relations(platformCategories, ({one}) => ({
	platform: one(platforms, {
		fields: [platformCategories.platformId],
		references: [platforms.id]
	}),
	baseCategory: one(baseCategories, {
		fields: [platformCategories.baseCategoryId],
		references: [baseCategories.id]
	}),
}));

export const platformsRelations = relations(platforms, ({many}) => ({
	platformCategories: many(platformCategories),
	platformCountries: many(platformCountries),
}));

export const baseCategoriesRelations = relations(baseCategories, ({many}) => ({
	platformCategories: many(platformCategories),
	products: many(products),
}));

export const platformCountriesRelations = relations(platformCountries, ({one, many}) => ({
	platform: one(platforms, {
		fields: [platformCountries.platformId],
		references: [platforms.id]
	}),
	country: one(countries, {
		fields: [platformCountries.countryId],
		references: [countries.id]
	}),
	providers: many(providers),
	products: many(products),
	productPlatforms: many(productPlatforms),
}));

export const countriesRelations = relations(countries, ({many}) => ({
	platformCountries: many(platformCountries),
}));

export const providersRelations = relations(providers, ({one, many}) => ({
	platformCountry: one(platformCountries, {
		fields: [providers.platformCountryId],
		references: [platformCountries.id]
	}),
	products: many(products),
}));

export const productsRelations = relations(products, ({one, many}) => ({
	provider: one(providers, {
		fields: [products.providerId],
		references: [providers.id]
	}),
	platformCountry: one(platformCountries, {
		fields: [products.platformCountryId],
		references: [platformCountries.id]
	}),
	baseCategory: one(baseCategories, {
		fields: [products.baseCategoryId],
		references: [baseCategories.id]
	}),
	multimedias: many(multimedia),
	productPlatforms: many(productPlatforms),
	histories: many(histories),
}));

export const multimediaRelations = relations(multimedia, ({one}) => ({
	product: one(products, {
		fields: [multimedia.productId],
		references: [products.id]
	}),
}));

export const productPlatformsRelations = relations(productPlatforms, ({one}) => ({
	product: one(products, {
		fields: [productPlatforms.productId],
		references: [products.id]
	}),
	platformCountry: one(platformCountries, {
		fields: [productPlatforms.platformCountryId],
		references: [platformCountries.id]
	}),
}));

export const historiesRelations = relations(histories, ({one}) => ({
	product: one(products, {
		fields: [histories.productId],
		references: [products.id]
	}),
}));