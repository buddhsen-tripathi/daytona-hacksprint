import { GraphView } from "@/components/graph-view";

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  return <GraphView mock={sp.mock === "1"} />;
}
