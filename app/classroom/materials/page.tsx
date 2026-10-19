import AuthClient from "@/app/auth-client";
import MaterialsWorkspace from "./workspace";

export const dynamic = "force-dynamic";

function queryValue(value: string | string[] | undefined, limit: number) {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const bookingId = queryValue(query.bookingId, 180);
  const occurrenceId = queryValue(query.occurrenceId, 240);
  const selectedClassroom = bookingId && occurrenceId.startsWith(`${bookingId}:`) && /^.+:\d{4}-\d{2}-\d{2}$/.test(occurrenceId)
    ? { bookingId, occurrenceId, sourceDate: occurrenceId.slice(-10) }
    : undefined;
  return <AuthClient authenticatedContent={<MaterialsWorkspace selectedClassroom={selectedClassroom} />} />;
}
