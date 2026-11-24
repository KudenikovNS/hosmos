"use client";

/**
 * The Demo and VESG Pro lead forms, and the modal that carries them (ТЗ §11).
 *
 * ONE COMPONENT, TWO FORMS. §11 gives the two forms five shared fields and four
 * different ones each, one shared submit pipeline, one shared consent block and
 * one shared success state. Splitting them into two components would duplicate
 * the interesting 90% — validation, focus management, the analytics events, the
 * "success only after the server saved it" rule — to vary the boring 10%.
 *
 * WHAT THE ACCESSIBILITY REQUIREMENTS ACTUALLY FORCE (§13, WCAG 2.2 AA):
 *   • the dialog holds focus and RETURNS it to whatever opened it;
 *   • Escape closes it;
 *   • errors are announced, referenced by `aria-describedby`, and focus moves to
 *     the first invalid field;
 *   • errors are never colour-only — each one is text next to its field, and a
 *     summary at the top of the form is a live region.
 * All four are implemented here rather than pulled from a dialog library,
 * because the page's performance budget (§13: LCP ≤2.5 s on mobile) is spent on
 * content, not on a modal abstraction the site uses exactly twice.
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

import { Button } from "@/shared/ui/Button";
import { track } from "@/shared/analytics";
import {
  isValid,
  validateLead,
  type LeadErrorCode,
  type LeadErrors,
  type LeadFormType,
} from "@/server/leads/validate";

import { errorSummary, type FormCopy } from "./copy";
import styles from "./LeadDialog.module.css";

/** What a CTA asks for when it opens the dialog. */
export interface LeadRequest {
  form: LeadFormType;
  /** Pre-selects "I'm interested in" on the Demo form (§11: CTA carries the plan). */
  plan?: string;
  /** Where the click happened — analytics only, never stored with the lead. */
  placement: string;
}

interface LeadDialogProps {
  request: LeadRequest;
  copy: FormCopy;
  locale: string;
  privacyHref: string;
  /** Which landing variant this dialog belongs to (§11 `landing_version`). */
  landingVersion: string;
  onClose: () => void;
}

/** Field ↔ error-code map as the form holds it while the visitor types. */
type FieldErrors = LeadErrors;

/** Selectors for everything focusable inside the dialog, for the focus trap. */
// Every branch carries `:not([tabindex="-1"])`: the honeypot is an <input> with
// `tabindex="-1"`, and the `input:not([disabled])` branch alone matched it — so
// the dialog opened with focus in a hidden field (UX audit 10.09.2026 §8).
const FOCUSABLE =
  'a[href]:not([tabindex="-1"]), button:not([disabled]):not([tabindex="-1"]), input:not([disabled]):not([tabindex="-1"]), select:not([disabled]):not([tabindex="-1"]), textarea:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])';

/** Field order per form — drives "focus the FIRST invalid field" (§13). */
const FIELD_ORDER: Record<LeadFormType, readonly string[]> = {
  demo: [
    "fullName",
    "email",
    "company",
    "country",
    "entityCount",
    "siteCount",
    "interest",
    "comment",
    "consentPrivacy",
  ],
  vesg: [
    "fullName",
    "email",
    "company",
    "inSlovenia",
    "companySize",
    "hasEmployee",
    "reportingPeriod",
    "comment",
    "consentPrivacy",
  ],
};

export function LeadDialog({
  request,
  copy,
  locale,
  privacyHref,
  landingVersion,
  onClose,
}: LeadDialogProps) {
  const { form, plan } = request;
  const isVesg = form === "vesg";

  const dialogRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  /** The element that had focus when the dialog opened — focus returns here. */
  const openerRef = useRef<HTMLElement | null>(null);
  /** `form_start` fires once per opening, on the first interaction (§12). */
  const startedRef = useRef(false);

  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const titleId = useId();
  const descriptionId = useId();
  const summaryId = useId();

  // ── Focus: capture the opener, move focus in, restore it on close ──────────
  useEffect(() => {
    openerRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    // Focus the first FORM field, not the dialog container and not the close
    // button that happens to come first in the DOM: a visitor who opened a form
    // wants to type. A screen reader still announces the dialog's name via
    // `aria-labelledby` when focus lands inside it. The honeypot is excluded by
    // `FOCUSABLE` because it carries `tabindex="-1"`.
    const first =
      formRef.current?.querySelector<HTMLElement>(FOCUSABLE) ??
      dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();

    const opener = openerRef.current;
    return () => opener?.focus();
  }, []);

  // ── Escape closes; Tab is trapped inside the dialog ───────────────────────
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;

      const nodes = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (!nodes || nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      // Wrap in both directions. Without this, Tab from the last control moves
      // focus to the browser chrome and the visitor cannot get back in.
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  // ── The page behind the dialog must not scroll under it ───────────────────
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  /** `form_start` — the first interaction with the form, once per opening (§12). */
  const noteStart = useCallback(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    track("form_start", { form_type: form });
  }, [form]);

  /** Read the form into a plain object the validator and the API both accept. */
  const readValues = useCallback((): Record<string, unknown> => {
    const data = new FormData(formRef.current!);
    const values: Record<string, unknown> = {};
    for (const [key, value] of data.entries()) {
      if (typeof value === "string") values[key] = value;
    }
    values.consentPrivacy = data.get("consentPrivacy") === "on";
    values.consentMarketing = data.get("consentMarketing") === "on";
    return values;
  }, []);

  /**
   * Re-validate one field after blur (§11). Only ever REMOVES or SETS that
   * field's error — validating the whole form on every blur would light up
   * fields the visitor has not reached yet.
   */
  const validateField = useCallback(
    (field: string) => {
      const all = validateLead(form, readValues());
      setErrors((prev) => {
        const next = { ...prev };
        if (all[field]) next[field] = all[field];
        else delete next[field];
        return next;
      });
    },
    [form, readValues],
  );

  /** Move focus to the first field that failed, in the form's own field order. */
  const focusFirstError = useCallback(
    (failed: FieldErrors) => {
      const first = FIELD_ORDER[form].find((field) => failed[field]);
      if (!first) return;
      const node = formRef.current?.elements.namedItem(first);
      if (node instanceof HTMLElement) node.focus();
    },
    [form],
  );

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setServerError(null);

    const values = readValues();
    const clientErrors = validateLead(form, values);
    if (!isValid(clientErrors)) {
      setErrors(clientErrors);
      focusFirstError(clientErrors);
      for (const [field, code] of Object.entries(clientErrors)) {
        track("form_error", { form_type: form, field, error_code: code });
      }
      return;
    }

    setErrors({});
    setSubmitting(true);
    try {
      const response = await fetch("/api/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...values,
          formType: form,
          locale,
          landingVersion,
          selectedPlan: plan ?? values.interest ?? null,
          referrer: document.referrer,
          utm: Object.fromEntries(new URLSearchParams(window.location.search)),
        }),
      });
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: string;
        errors?: FieldErrors;
      } | null;

      if (response.ok && payload?.ok) {
        // The server has SAVED the lead — only now is this a conversion (§12,
        // §16). `form_submit_success` carries the plan and nothing personal.
        track("form_submit_success", {
          form_type: form,
          selected_plan: plan ?? (values.interest as string | undefined),
        });
        setDone(true);
        return;
      }

      if (payload?.errors) {
        setErrors(payload.errors);
        focusFirstError(payload.errors);
      }
      const code =
        payload?.error === "RATE_LIMITED" ? "rateLimited" : ("server" as const);
      setServerError(copy.errors[code]);
      track("form_submit_failure", {
        form_type: form,
        error_code: payload?.error ?? String(response.status),
      });
    } catch {
      // Network failure: the lead was NOT saved, so the visitor must not see a
      // success state. Offering the footer address in the message is the point.
      setServerError(copy.errors.server);
      track("form_submit_failure", { form_type: form, error_code: "network" });
    } finally {
      setSubmitting(false);
    }
  }

  const errorCount = Object.keys(errors).length;
  const title = isVesg ? copy.vesgTitle : copy.demoTitle;
  const subtitle = isVesg ? copy.vesgSubtitle : copy.demoSubtitle;

  const body = (
    <div
      // `marketing` — the portal renders under <body>, outside the landing
      // wrapper, so the landing type scale is re-applied here.
      className={`marketing ${styles.overlay}`}
      // A click on the backdrop closes; a click that started inside the panel and
      // ended on the backdrop (a drag while selecting text) must not.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className={styles.panel}
      >
        <button
          type="button"
          className={styles.close}
          onClick={onClose}
          aria-label={copy.close}
        >
          <X size={20} aria-hidden="true" />
        </button>

        {done ? (
          <div className={styles.success}>
            <h2 id={titleId} className={styles.title}>
              {copy.successTitle}
            </h2>
            <p id={descriptionId} className={styles.subtitle}>
              {copy.successBody}
            </p>
            <Button onClick={onClose}>{copy.successClose}</Button>
          </div>
        ) : (
          <>
            <h2 id={titleId} className={styles.title}>
              {title}
            </h2>
            <p id={descriptionId} className={styles.subtitle}>
              {subtitle}
            </p>

            {/* Live region: announced when it gains content, so a screen-reader
                user learns the submit failed without hunting for the reason. */}
            <div
              id={summaryId}
              role="alert"
              aria-live="assertive"
              className={styles.summary}
            >
              {errorCount > 0 && <p>{errorSummary(copy, errorCount)}</p>}
              {serverError && <p>{serverError}</p>}
            </div>

            <form
              ref={formRef}
              onSubmit={onSubmit}
              noValidate
              onInput={noteStart}
            >
              {/* Honeypot: off-screen, not `display:none` (some bots skip hidden
                  inputs), never focusable, and excluded from the a11y tree. */}
              <div className={styles.honeypot} aria-hidden="true">
                <label htmlFor="website">{copy.honeypotLabel}</label>
                <input
                  id="website"
                  name="website"
                  type="text"
                  tabIndex={-1}
                  autoComplete="off"
                />
              </div>

              <Field
                name="fullName"
                label={copy.name}
                required
                autoComplete="name"
                copy={copy}
                errors={errors}
                onBlur={validateField}
              />
              <Field
                name="email"
                label={copy.email}
                type="email"
                required
                autoComplete="email"
                copy={copy}
                errors={errors}
                onBlur={validateField}
              />
              <Field
                name="company"
                label={copy.company}
                required
                autoComplete="organization"
                copy={copy}
                errors={errors}
                onBlur={validateField}
              />

              {isVesg ? (
                <>
                  <SelectField
                    name="inSlovenia"
                    label={copy.inSlovenia}
                    required
                    placeholder={copy.choose}
                    options={[
                      { value: "yes", label: copy.options.yes },
                      { value: "no", label: copy.options.no },
                    ]}
                    copy={copy}
                    errors={errors}
                    onBlur={validateField}
                  />
                  <SelectField
                    name="companySize"
                    label={copy.size}
                    required
                    placeholder={copy.choose}
                    options={[
                      { value: "micro", label: copy.options.sizeMicro },
                      { value: "small", label: copy.options.sizeSmall },
                      { value: "medium", label: copy.options.sizeMedium },
                      { value: "other", label: copy.options.sizeOther },
                    ]}
                    copy={copy}
                    errors={errors}
                    onBlur={validateField}
                  />
                  <SelectField
                    name="hasEmployee"
                    label={copy.hasEmployee}
                    placeholder={copy.choose}
                    options={[
                      { value: "yes", label: copy.options.yes },
                      { value: "no", label: copy.options.no },
                      { value: "unknown", label: copy.options.unknown },
                    ]}
                    copy={copy}
                    errors={errors}
                    onBlur={validateField}
                  />
                  <Field
                    name="reportingPeriod"
                    label={copy.period}
                    copy={copy}
                    errors={errors}
                    onBlur={validateField}
                  />
                </>
              ) : (
                <>
                  <Field
                    name="country"
                    label={copy.country}
                    autoComplete="country-name"
                    copy={copy}
                    errors={errors}
                    onBlur={validateField}
                  />
                  <SelectField
                    name="entityCount"
                    label={copy.entityCount}
                    required
                    placeholder={copy.choose}
                    options={[
                      { value: "1", label: copy.options.entities1 },
                      { value: "2-3", label: copy.options.entities2to3 },
                      { value: "4-10", label: copy.options.entities4to10 },
                      { value: "10+", label: copy.options.entities10plus },
                    ]}
                    copy={copy}
                    errors={errors}
                    onBlur={validateField}
                  />
                  <Field
                    name="siteCount"
                    label={copy.siteCount}
                    inputMode="numeric"
                    copy={copy}
                    errors={errors}
                    onBlur={validateField}
                  />
                  <SelectField
                    name="interest"
                    label={copy.interest}
                    required
                    // The CTA that opened the dialog pre-selects its own plan, so
                    // a visitor who clicked "Enterprise" never has to say so twice.
                    defaultValue={plan}
                    placeholder={copy.choose}
                    options={[
                      { value: "starter", label: copy.options.interestStarter },
                      { value: "pro", label: copy.options.interestPro },
                      {
                        value: "enterprise",
                        label: copy.options.interestEnterprise,
                      },
                      {
                        value: "white_label",
                        label: copy.options.interestWhiteLabel,
                      },
                    ]}
                    copy={copy}
                    errors={errors}
                    onBlur={validateField}
                  />
                </>
              )}

              <div className={styles.field}>
                <label htmlFor="comment" className={styles.label}>
                  {copy.comment}
                </label>
                <textarea
                  id="comment"
                  name="comment"
                  rows={3}
                  className={styles.textarea}
                  onBlur={() => validateField("comment")}
                />
              </div>

              {/* Consent: a separate, NOT pre-ticked checkbox, and the marketing
                  opt-in is independent of it (§11). */}
              <div className={styles.consentBlock}>
                <label className={styles.checkRow}>
                  <input
                    type="checkbox"
                    name="consentPrivacy"
                    aria-describedby={
                      errors.consentPrivacy ? `${summaryId}-consent` : undefined
                    }
                    aria-invalid={errors.consentPrivacy ? true : undefined}
                    onChange={() => validateField("consentPrivacy")}
                  />
                  <span>
                    {copy.consent}{" "}
                    <a
                      href={privacyHref}
                      className={styles.inlineLink}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {copy.consentLink}
                    </a>
                  </span>
                </label>
                {errors.consentPrivacy && (
                  <p id={`${summaryId}-consent`} className={styles.error}>
                    {copy.errors.consent}
                  </p>
                )}

                <label className={styles.checkRow}>
                  <input type="checkbox" name="consentMarketing" />
                  <span>{copy.marketing}</span>
                </label>
              </div>

              <Button
                type="submit"
                size="lg"
                loading={submitting}
                className={styles.submit}
              >
                {submitting
                  ? copy.submitting
                  : isVesg
                    ? copy.submitVesg
                    : copy.submit}
              </Button>
            </form>
          </>
        )}
      </div>
    </div>
  );

  // Portalled to `body` so no ancestor's `overflow`, `transform` or stacking
  // context can clip the dialog — the sticky header creates one of each.
  return createPortal(body, document.body);
}

// ── Field primitives ────────────────────────────────────────────────────────

interface FieldBaseProps {
  name: string;
  label: string;
  required?: boolean;
  copy: FormCopy;
  errors: FieldErrors;
  onBlur: (field: string) => void;
}

/** Message for an error code — never colour alone (§13). */
function messageFor(copy: FormCopy, code: LeadErrorCode | undefined) {
  if (!code) return null;
  return copy.errors[code];
}

function Field({
  name,
  label,
  required,
  type = "text",
  autoComplete,
  inputMode,
  copy,
  errors,
  onBlur,
}: FieldBaseProps & {
  type?: string;
  autoComplete?: string;
  inputMode?: "numeric" | "text";
}) {
  const message = messageFor(copy, errors[name]);
  const errorId = `${name}-error`;
  return (
    <div className={styles.field}>
      <label htmlFor={name} className={styles.label}>
        {label}
        {required && (
          <span className={styles.requiredMark}> ({copy.required})</span>
        )}
      </label>
      <input
        id={name}
        name={name}
        type={type}
        autoComplete={autoComplete}
        inputMode={inputMode}
        className={
          message ? `${styles.input} ${styles.inputError}` : styles.input
        }
        aria-invalid={message ? true : undefined}
        aria-describedby={message ? errorId : undefined}
        onBlur={() => onBlur(name)}
      />
      {message && (
        <p id={errorId} className={styles.error}>
          {message}
        </p>
      )}
    </div>
  );
}

function SelectField({
  name,
  label,
  required,
  placeholder,
  options,
  defaultValue,
  copy,
  errors,
  onBlur,
}: FieldBaseProps & {
  placeholder: string;
  options: Array<{ value: string; label: string }>;
  defaultValue?: string;
}) {
  const message = messageFor(copy, errors[name]);
  const errorId = `${name}-error`;
  return (
    <div className={styles.field}>
      <label htmlFor={name} className={styles.label}>
        {label}
        {required && (
          <span className={styles.requiredMark}> ({copy.required})</span>
        )}
      </label>
      <select
        id={name}
        name={name}
        defaultValue={defaultValue ?? ""}
        className={
          message ? `${styles.select} ${styles.inputError}` : styles.select
        }
        aria-invalid={message ? true : undefined}
        aria-describedby={message ? errorId : undefined}
        onBlur={() => onBlur(name)}
      >
        <option value="">{placeholder}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {message && (
        <p id={errorId} className={styles.error}>
          {message}
        </p>
      )}
    </div>
  );
}
