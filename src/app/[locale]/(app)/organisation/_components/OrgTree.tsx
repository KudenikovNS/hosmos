"use client";

// The organisation as ONE tree — parent → subsidiaries → sites → assets — the
// view the ESG expert asked for («Дерево организации», Тарифы Hosmos §frontend
// 2). Pure rendering over the three lists the sections below already load;
// nothing here writes, and a click leads to the section that owns the row.
import { Building2, Factory, Layers, Network } from "lucide-react";
import { useTranslations } from "next-intl";

import type { AssetDto } from "@/server/org/assets";
import type { FacilityDto } from "@/server/org/facilities";
import type { LegalEntityDto } from "@/server/org/legal-entities";
import { Badge } from "@/shared/ui/Badge";
import { Card } from "@/shared/ui/Card";

import styles from "../page.module.css";

export function OrgTree({
  entities,
  facilities,
  assets,
  rootId,
  entityLimit,
  facilityLimit,
}: {
  entities: readonly LegalEntityDto[];
  facilities: readonly FacilityDto[];
  assets: readonly AssetDto[];
  rootId: string | null;
  entityLimit: number;
  facilityLimit: number;
}) {
  const t = useTranslations("organisation");
  const childrenOf = (parentId: string | null) =>
    entities.filter((e) => (e.parent_organisation_id ?? null) === parentId);
  const roots = rootId
    ? entities.filter((e) => e.id === rootId)
    : childrenOf(null);
  // Entities whose parent is not in the list (a dangling reference) still show.
  const orphans = entities.filter(
    (e) =>
      e.parent_organisation_id !== null &&
      !entities.some((p) => p.id === e.parent_organisation_id) &&
      e.id !== rootId,
  );

  const counter = (
    used: number,
    limit: number,
    key: "entities" | "facilities",
  ) =>
    limit === -1
      ? t(`counters.${key}Unlimited`, { used })
      : t(`counters.${key}`, { used, limit });

  return (
    <Card className={styles.card}>
      <div className={styles.cardHeader}>
        <div className={styles.iconBox}>
          <Network size={20} className={styles.iconBlue} />
        </div>
        <div className={styles.headerGrow}>
          <h3 className={styles.cardTitle}>{t("tree.title")}</h3>
          <p className={styles.headerSubtitle}>{t("tree.subtitle")}</p>
        </div>
      </div>
      <p className={styles.treeCounters}>
        <Badge variant="blue" size="sm">
          {counter(entities.length, entityLimit, "entities")}
        </Badge>{" "}
        <Badge variant="violet" size="sm">
          {counter(facilities.length, facilityLimit, "facilities")}
        </Badge>{" "}
        <Badge variant="gray" size="sm">
          {t("counters.assets", { used: assets.length })}
        </Badge>
      </p>
      {entities.length === 0 ? (
        <p className={styles.mutedNote}>{t("group.empty")}</p>
      ) : (
        <ul className={styles.tree} aria-label={t("tree.title")}>
          {[...roots, ...orphans].map((entity) => (
            <EntityNode
              key={entity.id}
              entity={entity}
              depth={0}
              isRoot={entity.id === rootId}
              childrenOf={childrenOf}
              facilities={facilities}
              assets={assets}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}

function EntityNode({
  entity,
  depth,
  isRoot,
  childrenOf,
  facilities,
  assets,
}: {
  entity: LegalEntityDto;
  depth: number;
  isRoot: boolean;
  childrenOf: (parentId: string | null) => LegalEntityDto[];
  facilities: readonly FacilityDto[];
  assets: readonly AssetDto[];
}) {
  const t = useTranslations("organisation");
  const tEnum = useTranslations("organisation.enums");
  const sites = facilities.filter((f) => f.legal_entity_id === entity.id);
  const looseAssets = assets.filter(
    (a) => a.legal_entity_id === entity.id && a.facility_id === null,
  );
  const children = depth > 8 ? [] : childrenOf(entity.id);
  return (
    <li className={styles.treeNode}>
      <div className={styles.treeRow}>
        <Building2 size={16} className={styles.iconBlue} />
        <span className={styles.treeLabel}>{entity.organisation_name}</span>
        <Badge variant={isRoot ? "blue" : "gray"} size="sm">
          {isRoot ? t("group.root") : t("group.member")}
        </Badge>
        {entity.consolidation_method && (
          <span className={styles.treeMeta}>
            {tEnum.has(`consolidationMethod.${entity.consolidation_method}`)
              ? tEnum(`consolidationMethod.${entity.consolidation_method}`)
              : entity.consolidation_method}
            {entity.ownership_percentage !== null &&
              ` · ${entity.ownership_percentage}%`}
          </span>
        )}
        {!entity.registered_address && (
          <span className={styles.treeWarn}>{t("tree.noAddress")}</span>
        )}
      </div>
      {(sites.length > 0 || looseAssets.length > 0 || children.length > 0) && (
        <ul className={styles.treeChildren}>
          {sites.map((site) => (
            <li key={site.id} className={styles.treeNode}>
              <div className={styles.treeRow}>
                <Factory size={16} className={styles.iconViolet} />
                <span className={styles.treeLabel}>{site.facility_name}</span>
                <span className={styles.treeMeta}>
                  {site.facility_type
                    ? tEnum.has(`facilityType.${site.facility_type}`)
                      ? tEnum(`facilityType.${site.facility_type}`)
                      : site.facility_type
                    : "—"}
                  {site.country && ` · ${site.country}`}
                </span>
                <Badge
                  variant={site.included_in_boundary ? "green" : "gray"}
                  size="sm"
                >
                  {site.included_in_boundary
                    ? t("tree.inBoundary")
                    : t("tree.outsideBoundary")}
                </Badge>
              </div>
              <AssetList
                assets={assets.filter((a) => a.facility_id === site.id)}
              />
            </li>
          ))}
          {looseAssets.length > 0 && (
            <li className={styles.treeNode}>
              <div className={styles.treeRow}>
                <Layers size={16} className={styles.iconOff} />
                <span className={styles.treeMeta}>
                  {t("tree.assetsNoSite")}
                </span>
              </div>
              <AssetList assets={looseAssets} />
            </li>
          )}
          {children.map((child) => (
            <EntityNode
              key={child.id}
              entity={child}
              depth={depth + 1}
              isRoot={false}
              childrenOf={childrenOf}
              facilities={facilities}
              assets={assets}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function AssetList({ assets }: { assets: readonly AssetDto[] }) {
  const tEnum = useTranslations("organisation.enums");
  if (assets.length === 0) return null;
  return (
    <ul className={styles.treeChildren}>
      {assets.map((asset) => (
        <li key={asset.id} className={styles.treeLeaf}>
          <Layers size={14} className={styles.iconOff} />
          <span className={styles.treeLabel}>{asset.name}</span>
          <span className={styles.treeMeta}>
            {tEnum.has(`assetType.${asset.asset_type}`)
              ? tEnum(`assetType.${asset.asset_type}`)
              : asset.asset_type}
            {asset.identifier && ` · ${asset.identifier}`}
          </span>
        </li>
      ))}
    </ul>
  );
}
