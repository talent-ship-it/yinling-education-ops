import ClassroomDemo from "./classroom-demo";

export default async function ClassroomPage({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  return <ClassroomDemo roomId={decodeURIComponent(roomId)} />;
}
