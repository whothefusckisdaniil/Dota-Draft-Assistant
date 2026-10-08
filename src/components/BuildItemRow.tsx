import { APP_CONFIG } from '../config';
import type { ItemEntry } from '../types';
import type { RecommendedBuildItem } from '../scoring/buildEngine';

export type BuildItemRowProps = {
  item: Pick<RecommendedBuildItem, 'itemId' | 'rank'>;
  metadata?: ItemEntry;
};

export function BuildItemRow({ item, metadata }: BuildItemRowProps) {
  const image = metadata?.image
    ? `${APP_CONFIG.cdnBase}/apps/dota2/images/items/${metadata.image}`
    : null;

  return (
    <li className="panel-2 flex min-w-0 items-center gap-3 px-3 py-2.5">
      {image && (
        <img
          src={image}
          alt=""
          loading="lazy"
          className="aspect-square h-10 w-10 shrink-0 rounded object-cover"
          onError={(event) => {
            event.currentTarget.style.display = 'none';
          }}
        />
      )}
      <span className="min-w-0 flex-1 text-sm font-semibold text-ink" title={metadata?.name ?? `Item #${item.itemId}`}>
        {metadata?.name ?? `Item #${item.itemId}`}
      </span>
      <span className="shrink-0 text-[10px] text-dim" title="ItemPrior presentation rank">
        Prior #{item.rank}
      </span>
    </li>
  );
}
