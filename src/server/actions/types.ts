// Общий тип ответа транспортного слоя (ARCH-IMPL-SPEC §3.1).
//
// Server actions не бросают исключения через границу сервер/клиент: ошибка
// возвращается кодом внутри discriminated union. Чистые типы — без 'use server'
// и без импортов БД, поэтому модуль пригоден и для клиента, и для vitest.
//
// T3.8: раньше union дополнялся импортом `EmissionsErrorCode` из легаси-модуля
// `emissions/errors` (T-8: COMPANY_NOT_FOUND + NO_MONTHLY_DATA +
// FACTORS_UNAVAILABLE + PERSIST_FAILED). Этот модуль удалён вместе со всем
// широкотабличным движком, поэтому union ПОДРЕЗАН до того, что реально возвращают
// выжившие потребители: `NO_MONTHLY_DATA`/`FACTORS_UNAVAILABLE`/`PERSIST_FAILED`
// были кодами месячного расчёта и после его удаления их не возвращает никто, а
// `COMPANY_NOT_FOUND` нужен (refusal.ts, useMembers, useInvitations и все
// route-хендлеры на нём стоят) — он и инлайнится литералом здесь.
//
// Источник кодов ТРАНСПОРТА (HTTP) — `ApiErrorCode` в `src/server/api/handler.ts`:
// он шире (FORBIDDEN/PLAN_REQUIRED/VALIDATION/…), и ответы `app/api/*` типизируются
// им. `ActionErrorCode` — узкая клиентская форма ответа, и она специально открыта
// на дополнение: потребители дискриминируют по `ok` и сравнивают отдельные коды.
type ActionErrorCode =
  | "UNAUTHENTICATED" // нет сессии
  | "COMPANY_NOT_FOUND" // членство пропало / у юзера нет компании
  | "UNKNOWN"; // всё прочее — детали остаются в серверном логе

export type ActionResult<T> =
  { ok: true; data: T } | { ok: false; error: ActionErrorCode };
