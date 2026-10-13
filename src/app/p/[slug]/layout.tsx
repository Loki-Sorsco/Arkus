import { notFound } from "next/navigation";
import { WorkspaceProvider, type ProjectDetail } from "@/components/shell/workspace";
import { projectDetail } from "@/lib/arkus/project";

export const dynamic = "force-dynamic";

export default async function WorkspaceLayout({ children, params }: { children: React.ReactNode; params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const project = await projectDetail(slug);
  if (!project) notFound();
  return <WorkspaceProvider slug={slug} initial={JSON.parse(JSON.stringify(project)) as ProjectDetail}>{children}</WorkspaceProvider>;
}
