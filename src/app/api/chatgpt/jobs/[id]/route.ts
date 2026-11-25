import { withApi } from "@/server/http/handler";
import { ok } from "@/server/http/responses";
import { requireApiKey } from "@/server/http/auth";
import { requireParamId } from "@/server/http/id";
import { chatgptJobsRepo } from "@/server/db/chatgpt-jobs.repo";
import { toChatGptJobDto } from "@/server/services/chatgpt.service";

export const dynamic = "force-dynamic";
type Ctx = { id: string };

export const GET = withApi<Ctx>(async (request, { params }) => {
  await requireApiKey(request);
  const id = requireParamId((await params).id, "job id");
  const job = await chatgptJobsRepo.get(id);
  if (!job) return ok({ job: null });
  return ok({ job: toChatGptJobDto(job) });
});
