import { withApi } from "@/server/http/handler";
import { ok } from "@/server/http/responses";
import { requireApiKey } from "@/server/http/auth";
import { requireParamId } from "@/server/http/id";
import { chatgptJobsRepo } from "@/server/db/chatgpt-jobs.repo";
import { toChatGptJobDto } from "@/server/services/chatgpt.service";

export const dynamic = "force-dynamic";
type Ctx = { id: string };

/** Cancel a queued/running job; the extension will ignore a late answer. */
export const POST = withApi<Ctx>(async (request, { params }) => {
  await requireApiKey(request);
  const id = requireParamId((await params).id, "job id");
  const row = await chatgptJobsRepo.cancel(id);
  return ok({ job: toChatGptJobDto(row) });
});
