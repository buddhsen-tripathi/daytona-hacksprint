import { RepairsView } from "@/components/repairs-view";

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  return <RepairsView mock={sp.mock === "1"} />;
}
