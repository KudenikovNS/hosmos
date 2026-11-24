// =============================================================================
// VAL-* RULE INVENTORY — the Phase-1 rule registry as CODE (spec §6.1/§6.2, F6).
//
// WHY A CONSTANT AND NOT A TABLE. DM-28 is explicit: `validation_result` stores
// RESULTS; the rule catalogue is `VALIDATION_RULES`, a code constant (§4.18,
// §0.8). A rule's severity and blocking flag decide whether a submit, approve
// or lock is refused — behaviour, not data — so it belongs with the code that
// branches on it and goes through review with it. Behind a table, `blocking`
// would be a row someone could flip in production.
//
// ALL 42 CODES ARE HERE AT ONCE, evaluators or not. That is the whole
// point of the R-12 guard in `./registry`: a code in this array with neither an
// evaluator nor a `PENDING_EVALUATORS` entry throws at startup, so a rule can
// never "pass" merely because nobody implemented it. The inventory is therefore
// the honest scope of Phase-1 validation, and the manifest is the honest state
// of it.
//
// EXCLUDED FROM PHASE 1 (§6.3) — deliberately ABSENT from the array, listed
// here so a reader looking for them finds the reason rather than a gap:
//   • VAL-025…VAL-030 — Scope 3 (Phase 3).
//   • VAL-042, VAL-043 — Targets (Phase 5). VAL-107 — the factor-basis warning
//     added with factor provenance — is in К-11's PLATFORM range for exactly
//     that reason: it is this engine's rule, not a §6.2 cell, and taking a
//     reserved code for it would collide with Phase 5.
// Also noted by §6.3: VAL-011…VAL-014 in their native `source_record` wording
// return with the Phase-2 intake layer (F3). The Phase-1 wording used below
// (К-15 — the same checks against the input tables) stays valid.
//
// MESSAGES ARE THE CANONICAL RUSSIAN (О-12). `validation_result.message` keeps
// the RU text for audit, logs and debugging exactly as §6.1 requires; the UI
// never renders this string — it looks up `rule_code` in `messages/{en,sl}.json`
// under the `validation` namespace. Both locales carry all 42 codes as of this
// task, so S3–S5 add evaluators without touching a locale file.
//   The wording is the §6.2 cell verbatim, minus the spec's own cross-reference
//   markers (К-15, D15, EV-5, "константа, зафиксирована в formula_version — S3"
//   …): those annotate the SPEC, not the rule, and would be noise in an
//   auditor's export. Where a cell carried such a note it is preserved as a
//   comment on the rule instead.
// =============================================================================

/**
 * `validation_result.scope` (DM-28) — the four levels a result can belong to,
 * and by VR-3 the four things a blocking failure stops:
 *   • `record`        — one input row; blocks approving that row and submit.
 *   • `revision`      — the report revision; blocks submit / approve / lock.
 *   • `period`        — the reporting period and its boundary; blocks lock and
 *                       render.
 *   • `reference_org` — an organisational or reference record (legal entity,
 *                       facility, emission factor); blocks saving that record.
 *
 * These live here rather than in `@/shared/enums` on purpose: they are not a
 * domain list of the data model but the structure of the validation engine
 * itself, and the schema CHECK on `validation_result.scope` is their pair.
 */
export const VALIDATION_SCOPES = [
  "record",
  "revision",
  "period",
  "reference_org",
] as const;
export type ValidationScope = (typeof VALIDATION_SCOPES)[number];

/** `validation_result.severity` — `error` may block, `warning` never does. */
export const VALIDATION_SEVERITIES = ["error", "warning"] as const;
type ValidationSeverity = (typeof VALIDATION_SEVERITIES)[number];

/**
 * One rule of the Phase-1 inventory, shaped exactly as spec §6.1.
 *
 * `blocking` is not a synonym of `severity`: every blocking rule is an `error`
 * (asserted in `__tests__/rules.test.ts`), but an `error` may be non-blocking —
 * it is then a hard problem that still does not stop the workflow.
 *
 * `appliesTo` holds TABLE NAMES, the same vocabulary as
 * `validation_result.object_type` / `evidence_link.linked_object_type` (К-8).
 * It is a superset of `OBJECT_TYPES` from `@/shared/enums`: that list is the
 * evidence-link vocabulary (seven linkable tables), while a rule may target a
 * `reporting_period`, a `report_revision` or a `calculation`, none of which
 * carry evidence. The test pins every value against the real schema.
 */
export interface ValidationRule {
  readonly code: `VAL-${string}`;
  readonly domain: string;
  readonly scope: ValidationScope;
  readonly severity: ValidationSeverity;
  readonly blocking: boolean;
  /** Canonical RU text (О-12) — persisted, never rendered. */
  readonly message: string;
  /** Target table name(s) — `validation_result.object_type` values. */
  readonly appliesTo: readonly string[];
}

/**
 * The Phase-1 inventory: 35 domain rules (VAL-001…024, 031…041) + 7 platform
 * rules (VAL-101…107) = 42. Order follows §6.2; VAL-107 is this engine's own
 * (see its comment), which is why it closes the platform range rather than
 * taking a reserved §6.2 number.
 */
export const VALIDATION_RULES = [
  // ─── Organisation (§6.2, reference_org) ────────────────────────────────────
  {
    code: "VAL-001",
    domain: "Organisation",
    scope: "reference_org",
    severity: "error",
    blocking: true,
    message: "Обязательные поля организации (name/country/registration_number)",
    appliesTo: ["legal_entity"],
  },
  {
    code: "VAL-002",
    domain: "Organisation",
    scope: "reference_org",
    severity: "error",
    blocking: true,
    message: "country/currency/NACE из актуального справочника",
    appliesTo: ["legal_entity"],
  },
  {
    code: "VAL-003",
    domain: "Organisation",
    scope: "reference_org",
    severity: "error",
    blocking: true,
    message: "Нет циклов в иерархии группы",
    appliesTo: ["legal_entity"],
  },
  {
    code: "VAL-004",
    domain: "Organisation",
    scope: "reference_org",
    severity: "error",
    blocking: true,
    message: "effective_from ≤ effective_to",
    appliesTo: ["legal_entity"],
  },

  // ─── Facility (§6.2) ───────────────────────────────────────────────────────
  {
    code: "VAL-005",
    domain: "Facility",
    scope: "reference_org",
    severity: "error",
    blocking: true,
    message: "Площадка привязана к действующему юрлицу",
    appliesTo: ["facility"],
  },
  {
    code: "VAL-006",
    domain: "Facility",
    scope: "reference_org",
    severity: "error",
    blocking: true,
    message: "Координаты в диапазоне (−90…90 / −180…180)",
    appliesTo: ["facility"],
  },
  {
    code: "VAL-007",
    domain: "Facility",
    scope: "record",
    severity: "warning",
    blocking: false,
    message: "Активность вне дат эксплуатации площадки",
    appliesTo: ["emission_activity", "purchased_energy_activity"],
  },

  // ─── Period (§6.2) ─────────────────────────────────────────────────────────
  {
    code: "VAL-008",
    domain: "Period",
    scope: "period",
    severity: "error",
    blocking: true,
    message: "start_date < end_date периода",
    appliesTo: ["reporting_period"],
  },
  {
    code: "VAL-009",
    domain: "Period",
    scope: "period",
    severity: "warning",
    blocking: false,
    message: "Пересечение отчётных периодов",
    appliesTo: ["reporting_period"],
  },
  {
    // "все факты" (§6.2) — the four input tables of the D23 mixin.
    code: "VAL-010",
    domain: "Period",
    scope: "period",
    severity: "error",
    blocking: true,
    message: "Locked неизменяем (любая мутация против locked)",
    appliesTo: [
      "emission_activity",
      "purchased_energy_activity",
      "contractual_instrument",
      "disclosure_record",
    ],
  },

  // ─── Activity rows (§6.2, К-15 wording — see the header note) ──────────────
  {
    code: "VAL-011",
    domain: "Activity",
    scope: "record",
    severity: "error",
    blocking: true,
    message: "Значение активности ≥ 0",
    appliesTo: ["emission_activity", "purchased_energy_activity"],
  },
  {
    code: "VAL-012",
    domain: "Activity",
    scope: "record",
    severity: "warning",
    blocking: false,
    message: "Даты данных внутри отчётного периода",
    appliesTo: [
      "emission_activity",
      "purchased_energy_activity",
      "contractual_instrument",
      "disclosure_record",
    ],
  },
  {
    code: "VAL-013",
    domain: "Evidence",
    scope: "record",
    severity: "warning",
    blocking: false,
    message: "Возможный дубликат документа (hash/issuer/date)",
    appliesTo: ["document"],
  },
  {
    code: "VAL-014",
    domain: "Activity",
    scope: "record",
    severity: "error",
    blocking: true,
    message: "Единица поддерживается для типа активности",
    appliesTo: ["emission_activity", "purchased_energy_activity"],
  },
  {
    code: "VAL-015",
    domain: "Activity",
    scope: "record",
    severity: "error",
    blocking: true,
    message: "Выбран метод, но нет входа (fuel/activity required)",
    appliesTo: ["emission_activity"],
  },
  {
    code: "VAL-016",
    domain: "Activity",
    scope: "record",
    severity: "error",
    blocking: true,
    message:
      "Полнота метода автопарка (distance ⇒ vehicle type; fuel ⇒ litres)",
    appliesTo: ["emission_activity"],
  },
  {
    code: "VAL-017",
    domain: "Calculation",
    scope: "revision",
    severity: "error",
    blocking: true,
    message: "Биогенный CO₂ раскрывается отдельно от фоссильного",
    appliesTo: ["calculation"],
  },
  {
    code: "VAL-018",
    domain: "Activity",
    scope: "record",
    severity: "warning",
    blocking: false,
    message: "Mass balance хладагента неотрицателен",
    appliesTo: ["emission_activity"],
  },
  {
    code: "VAL-019",
    domain: "Activity",
    scope: "record",
    severity: "error",
    blocking: true,
    message: "Для хладагента есть фактор/GWP в наборе",
    appliesTo: ["emission_activity"],
  },

  // ─── Purchased energy and contractual instruments (§6.2) ───────────────────
  {
    code: "VAL-020",
    domain: "Energy",
    scope: "record",
    severity: "error",
    blocking: true,
    message: "Потребление энергии ≥ 0",
    appliesTo: ["purchased_energy_activity"],
  },
  {
    code: "VAL-021",
    domain: "Energy",
    scope: "record",
    severity: "error",
    blocking: true,
    message: "Для Scope 2 нужна страна площадки",
    appliesTo: ["purchased_energy_activity"],
  },
  {
    code: "VAL-022",
    domain: "Instrument",
    scope: "revision",
    severity: "error",
    blocking: true,
    message: "covered_volume ≤ сопоставленное потребление",
    appliesTo: ["contractual_instrument"],
  },
  {
    code: "VAL-023",
    domain: "Instrument",
    scope: "record",
    severity: "warning",
    blocking: false,
    message: "Период сертификата совместим с периодом",
    appliesTo: ["contractual_instrument"],
  },
  {
    code: "VAL-024",
    domain: "Energy",
    scope: "revision",
    severity: "error",
    blocking: true,
    message: "Market-based баланс: covered + residual = consumption",
    appliesTo: ["purchased_energy_activity", "contractual_instrument"],
  },

  // ─── Emission factors (§6.2) ───────────────────────────────────────────────
  {
    code: "VAL-031",
    domain: "Factor",
    scope: "reference_org",
    severity: "error",
    blocking: true,
    message: "Уникальный ключ фактора",
    appliesTo: ["emission_factor"],
  },
  {
    code: "VAL-032",
    domain: "Factor",
    scope: "reference_org",
    severity: "error",
    blocking: true,
    message: "Валидность фактора (valid_from ≤ valid_to, applicable_year)",
    appliesTo: ["emission_factor"],
  },
  {
    code: "VAL-033",
    domain: "Factor",
    scope: "reference_org",
    severity: "error",
    blocking: true,
    message: "Фактор ≠ 0 (кроме явно валидного нуля); нулём не подменять",
    appliesTo: ["emission_factor"],
  },

  // ─── Calculation and lineage (§6.2) ────────────────────────────────────────
  {
    // The 0.5% tolerance is a constant pinned in `formula_version` (S3, T5.4).
    code: "VAL-034",
    domain: "Calculation",
    scope: "revision",
    severity: "error",
    blocking: true,
    message: "Сверка: сумма деталей = итог; допуск 0.5%",
    appliesTo: ["calculation", "report_render"],
  },
  {
    code: "VAL-035",
    domain: "Calculation",
    scope: "revision",
    severity: "error",
    blocking: true,
    message: "Полнота lineage (source/factor/formula version)",
    appliesTo: ["calculation"],
  },

  // ─── Evidence and data quality (§6.2) ──────────────────────────────────────
  {
    // EV-5 semantics: blocks approving the ROWS linked to the broken document,
    // and is checked at approve/lock — not at upload.
    code: "VAL-036",
    domain: "Evidence",
    scope: "record",
    severity: "error",
    blocking: true,
    message: "Целостность файла эвиденса (hash есть, файл доступен)",
    appliesTo: ["document"],
  },
  {
    code: "VAL-037",
    domain: "Evidence",
    scope: "record",
    severity: "warning",
    blocking: false,
    message: "Покрытие периода эвиденсом",
    appliesTo: ["evidence_link"],
  },
  {
    code: "VAL-038",
    domain: "DataQuality",
    scope: "record",
    severity: "warning",
    blocking: false,
    message: "Заполнены обязательные DQ-оценки",
    appliesTo: ["dq_assessment"],
  },
  {
    code: "VAL-039",
    domain: "DataQuality",
    scope: "record",
    severity: "error",
    blocking: true,
    message: "Причина ручного оверрайда DQ обязательна",
    appliesTo: ["dq_assessment"],
  },

  // ─── Workflow (§6.2) ───────────────────────────────────────────────────────
  {
    code: "VAL-040",
    domain: "Workflow",
    scope: "revision",
    severity: "warning",
    blocking: false,
    message: "Разделение обязанностей (вносил ≠ утверждает)",
    appliesTo: ["report_revision"],
  },
  {
    code: "VAL-041",
    domain: "Workflow",
    scope: "revision",
    severity: "error",
    blocking: true,
    message: "Предпосылки утверждения: нет критических ошибок/дыр в эвиденсе",
    appliesTo: ["report_revision"],
  },

  // ─── Platform rules (§6.2, range 101+, К-11) ───────────────────────────────
  {
    // D15 — the boundary must say WHY an entity is out.
    code: "VAL-101",
    domain: "Boundary",
    scope: "period",
    severity: "error",
    blocking: true,
    message: "exclusion_reason обязателен при period_scope.status='excluded'",
    appliesTo: ["period_scope"],
  },
  {
    // D17 + the paid-PDF acceptance AC-9.
    code: "VAL-102",
    domain: "Period",
    scope: "period",
    severity: "error",
    blocking: true,
    message:
      "Консолидированный отчёт: ≥2 включённых юрлица и обозначенная материнская",
    appliesTo: ["reporting_period"],
  },
  {
    // D14 + the paid-PDF acceptance AC-10.
    code: "VAL-103",
    domain: "Organisation",
    scope: "period",
    severity: "error",
    blocking: true,
    message:
      "У каждого включённого юрлица заполнен registered_address до lock/рендера",
    appliesTo: ["legal_entity"],
  },
  {
    // Gap & Roadmap AC (К-18) — AC-2.
    code: "VAL-104",
    domain: "Activity",
    scope: "record",
    severity: "error",
    blocking: true,
    message:
      "Emission/energy строка без facility_id требует непустого notes (documented exception)",
    appliesTo: ["emission_activity", "purchased_energy_activity"],
  },
  {
    // F1. The REFUSAL is the plan gate (§11.3, 402 PLAN_REQUIRED); this rule is
    // written so the UI can show WHY, which is why it is blocking-by-record even
    // though no evaluator refuses on its own.
    code: "VAL-105",
    domain: "Boundary",
    scope: "period",
    severity: "error",
    blocking: true,
    message:
      "Starter: >3 включаемых площадок — завершение отчёта требует апгрейда",
    appliesTo: ["reporting_period"],
  },
  {
    // DM-7a — the VAL-010 family applied to the period and its boundary.
    code: "VAL-106",
    domain: "Period",
    scope: "period",
    severity: "error",
    blocking: true,
    message:
      "Расчётно-значимые поля периода и строки period_scope неизменяемы, пока текущая ревизия не в draft/rejected",
    appliesTo: ["reporting_period", "period_scope"],
  },
  {
    // NOT WRONG, AND YOU SHOULD KNOW. The ladder took the only factor of the
    // pinned set the entered data could reach; the set nevertheless holds a
    // BETTER one — for the site's own country, or for the record's own year —
    // that the unit or the year could not reach. The figure is right, published
    // and re-derivable; what it is not is the strongest basis the set offers,
    // and a preparer who never learns that will enter the same rows in the same
    // unit next year. Hence WARNING and NON-BLOCKING: refusing a report over a
    // disclosable methodology choice would be worse than disclosing it, which is
    // §0.7's argument read the other way round.
    //
    // IT IS A PLATFORM RULE (101+) AND NOT VAL-042. §6.3 reserves VAL-042/043
    // for Targets in Phase 5, and `rules.test.ts` holds both in its excluded
    // list precisely so that a later phase's code cannot be taken by an earlier
    // one. This rule is not a §6.2 cell at all — it is a property of THIS
    // engine's factor ladder — so it belongs in К-11's range with the others.
    //
    // `scope: revision` because the subject is a `calculation` row, and those
    // exist only once a run has happened — the same reason VAL-017/034/035 sit
    // on the revision rather than on the input row.
    code: "VAL-107",
    domain: "Calculation",
    scope: "revision",
    severity: "warning",
    blocking: false,
    message: "Фактор слабее доступного в наборе (страна/год не достигнуты)",
    appliesTo: ["calculation"],
  },
] as const satisfies readonly ValidationRule[];

/**
 * One rule AS DECLARED — the literal object type, so `code` is the exact code
 * rather than the interface's `VAL-${string}`. That is what lets the registry
 * be keyed by `ValidationRuleCode` and still be indexable from a rule.
 */
export type Phase1Rule = (typeof VALIDATION_RULES)[number];

/** Every code of the Phase-1 inventory, as a literal union. */
export type ValidationRuleCode = Phase1Rule["code"];

/** Rules indexed by code — the lookup `runValidation` and the routes use. */
const RULES_BY_CODE = new Map<string, ValidationRule>(
  VALIDATION_RULES.map((rule) => [rule.code, rule]),
);

/** The rule for `code`, or `undefined` when the code is not in the inventory. */
export function findRule(code: string): ValidationRule | undefined {
  return RULES_BY_CODE.get(code);
}

/** Every rule whose `scope` is `scope` (the candidates for one run). */
export function rulesForScope(scope: ValidationScope): Phase1Rule[] {
  return VALIDATION_RULES.filter((rule) => rule.scope === scope);
}
