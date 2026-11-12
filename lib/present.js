import { recommend } from "@/engine/recommend";
import { routeEdgeCases, unitEdgeCases } from "@/engine/edgecases";

// what the browser needs: the model without the (large) extracted function sources, plus the analysis
export function present(model) {
  const rec = recommend(model);
  const topUnits = new Set(model.units.filter((u) => u.complexity > 1 || u.params.length).sort((a, b) => b.complexity - a.complexity).slice(0, 80).map((u) => u.id));
  return {
    ...model, units: model.units.map(({ extractSource, ...u }) => u), recommendation: rec,
    edgeCases: { routes: Object.fromEntries(model.routes.map((r) => [r.id + "|" + r.service, routeEdgeCases(r)])), units: Object.fromEntries(model.units.filter((u) => topUnits.has(u.id)).map((u) => [u.id, unitEdgeCases(u)])) },
  };
}
