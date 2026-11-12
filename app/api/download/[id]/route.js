import { guard, fail } from "@/lib/guard";
import { loadJson } from "@/lib/store";
import { makeZip } from "@/engine/zip";

export const dynamic = "force-dynamic";

export async function GET(req, { params }) {
  const denied = guard(req);
  if (denied) return denied;
  const gen = loadJson("gens", (await params).id);
  if (!gen) return fail(404, "Generated tests not found");
  const zip = makeZip(gen.files.map((f) => ({ path: "tests-generated/" + f.path, content: f.content })));
  return new Response(zip, { headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="tests-generated.zip"` } });
}
