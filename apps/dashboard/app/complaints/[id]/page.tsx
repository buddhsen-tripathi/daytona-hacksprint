import { ComplaintView } from "@/components/complaint-view";

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  return <ComplaintView id={decodeURIComponent(id)} mock={sp.mock === "1"} />;
}
