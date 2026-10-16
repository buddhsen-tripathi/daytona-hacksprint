import { Console } from "@/components/console";

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  return <Console mock={sp.mock === "1"} />;
}
