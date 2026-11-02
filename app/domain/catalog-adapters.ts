import { z } from "zod";
import { DomainError } from "./guards";

const gid = (type: string) => z.string().regex(new RegExp(`^gid://shopify/${type}/[0-9]+$`));
const option = z.object({ name: z.string().trim().min(1).max(80), values: z.array(z.string().trim().min(1).max(255)).min(1).max(50) }).strict();
const decimal = z.string().regex(/^\d{1,12}(\.\d{1,4})?$/);
const variant = z.object({ optionValues: z.array(z.object({ optionName: z.string().min(1).max(80), name: z.string().min(1).max(255) }).strict()).max(3), price: decimal, compareAtPrice: decimal.nullable().optional(), sku: z.string().max(255).optional(), barcode: z.string().max(255).optional(), taxable: z.boolean().optional() }).strict();
const scalarTypes = ["single_line_text_field", "multi_line_text_field", "number_integer", "number_decimal", "boolean", "json"] as const;
export const catalogInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("CREATE_DRAFT"), title: z.string().trim().min(1).max(255), handle: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(255), descriptionHtml: z.string().max(30000).default(""), vendor: z.string().max(255).default(""), productType: z.string().max(255).default(""), tags: z.array(z.string().max(255)).max(50).default([]), options: z.array(option).max(3).default([]), variants: z.array(variant).max(50).default([]) }).strict(),
  z.object({ kind: z.literal("ADD_OPTIONS"), productId: gid("Product"), options: z.array(option).min(1).max(3) }).strict(),
  z.object({ kind: z.literal("ADD_VARIANTS"), productId: gid("Product"), variants: z.array(variant).min(1).max(50) }).strict(),
  z.object({ kind: z.literal("ADD_MEDIA"), productId: gid("Product"), media: z.array(z.object({ originalSource: z.url().refine((v) => { const u = new URL(v); return u.protocol === "https:" && !u.username && !u.password && !u.hash; }, "Use a public HTTPS asset URL without credentials or fragment"), alt: z.string().max(512).default(""), mediaContentType: z.literal("IMAGE") }).strict()).min(1).max(10) }).strict(),
  z.object({ kind: z.literal("SET_METAFIELD"), ownerId: z.string().regex(/^gid:\/\/shopify\/(Product|ProductVariant)\/[0-9]+$/), namespace: z.string().regex(/^[a-zA-Z0-9_-]{3,255}$/), key: z.string().regex(/^[a-zA-Z0-9_-]{3,64}$/), type: z.enum(scalarTypes), value: z.string().max(30000) }).strict(),
  z.object({ kind: z.literal("ADD_TO_COLLECTION"), productId: gid("Product"), collectionId: gid("Collection") }).strict(),
]);
export type CatalogInput = z.infer<typeof catalogInputSchema>;
export type CatalogOption = z.infer<typeof option>;
export type CatalogVariant = z.infer<typeof variant>;
export function parseCatalogInput(value: unknown): CatalogInput {
  const input = catalogInputSchema.parse(value);
  if ("options" in input) {
    const names = input.options.map((v) => v.name.toLowerCase());
    if (new Set(names).size !== names.length || input.options.some((o) => new Set(o.values.map((v) => v.toLowerCase())).size !== o.values.length))
      throw new DomainError("DUPLICATE_OPTION", "Option names and values must be unique.");
  }
  if ("variants" in input) {
    const combinations = input.variants.map((v) => optionKey(v.optionValues));
    if (new Set(combinations).size !== combinations.length)
      throw new DomainError("DUPLICATE_VARIANT", "Each variant must have a unique option combination.");
    for (const v of input.variants) if (new Set(v.optionValues.map((o) => o.optionName.toLowerCase())).size !== v.optionValues.length)
      throw new DomainError("DUPLICATE_OPTION", "A variant must contain each option once.");
    if (input.kind === "CREATE_DRAFT") validateVariantOptions(input.variants, input.options);
  }
  if (input.kind === "ADD_MEDIA" && new Set(input.media.map((m) => m.originalSource)).size !== input.media.length)
    throw new DomainError("DUPLICATE_MEDIA", "Each asset URL may appear only once in a plan.");
  if (input.kind === "SET_METAFIELD") {
    if (input.namespace === "app" || input.namespace.startsWith("app--"))
      throw new DomainError("RESERVED_NAMESPACE", "This adapter supports explicitly allowlisted merchant-owned definitions.");
    const value = input.value;
    if ((input.type === "boolean" && !["true", "false"].includes(value)) || (input.type === "number_integer" && !/^-?\d+$/.test(value)) || (input.type === "number_decimal" && !/^-?\d+(\.\d+)?$/.test(value)) || (input.type === "single_line_text_field" && /[\r\n]/.test(value)))
      throw new DomainError("METAFIELD_VALUE", "The value does not match the selected metafield type.");
    if (input.type === "json") { try { JSON.parse(value); } catch { throw new DomainError("METAFIELD_VALUE", "Enter a valid JSON metafield value."); } }
  }
  return input;
}
export function optionKey(values: { optionName: string; name: string }[]) {
  return JSON.stringify([...values].map(({ optionName, name }) => [optionName, name]).sort(([a], [b]) => a.localeCompare(b)));
}
export function validateVariantOptions(variants: CatalogVariant[], options: CatalogOption[]) {
  for (const variant of variants) if (variant.optionValues.length !== options.length || options.some((o) => !variant.optionValues.some((v) => v.optionName === o.name && o.values.includes(v.name))))
    throw new DomainError("OPTION_MISMATCH", "Every variant must select exactly one existing value for each product option.");
}
export function variantInputs(variants: CatalogVariant[]) {
  return variants.map(({ sku, ...v }) => ({ ...v, ...(sku === undefined ? {} : { inventoryItem: { sku } }) }));
}
export function optionInputs(options: CatalogOption[]) {
  return options.map(({ name, values }) => ({ name, values: values.map((value) => ({ name: value })) }));
}
