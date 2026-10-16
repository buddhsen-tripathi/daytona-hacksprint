import { CatalogView } from "@/components/catalog-view";

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  return <CatalogView mock={sp.mock === "1"} />;
}
