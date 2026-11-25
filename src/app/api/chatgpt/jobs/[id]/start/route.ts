import { withApi } from "@/server/http/handler";
import { ok } from "@/server/http/responses";
import { requireApiKey } from "@/server/http/auth";
import { requireParamId } from "@/server/http/id";
import { chatgptJobsRepo } from "@/server/db/chatgpt-jobs.repo";
import { toChatGptJobDto } from "@/server/services/chatgpt.service";

export const dynamic = "force-dynamic";
type Ctx = { id: string };

/** Claim a queued job, or reopen a failed one for a manual paste (idempotent). */
export const POST = withApi<Ctx>(async (request, { params }) => {
  await requireApiKey(request);
  const id = requireParamId((await params).id, "job id");
  const result = await chatgptJobsRepo.start(id);
  return ok({ job: toChatGptJobDto(result.job), claimed: result.claimed });
});
