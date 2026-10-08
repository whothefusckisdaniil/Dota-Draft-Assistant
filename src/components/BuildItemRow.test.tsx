import { describe, expect, it } from 'vitest';
import { Children, isValidElement, type ReactEventHandler, type SyntheticEvent } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import heroesData from '../../public/data/heroes.json';
import itemsData from '../../public/data/items.json';
import itemStatsData from '../../public/data/item-stats.json';
import positionsData from '../../public/data/positions.json';
import { APP_CONFIG } from '../config';
import type { BuildEngineDataset, RecommendedBuildItem } from '../scoring/buildEngine';
import { createBuildEngine } from '../scoring/buildEngine';
import type { ItemEntry } from '../types';
import { BuildItemRow } from './BuildItemRow';
import { RecommendedBuildPanel } from './RecommendedBuildPanel';

const item: Pick<RecommendedBuildItem, 'itemId' | 'rank'> = { itemId: 145, rank: 3 };
const metadata: ItemEntry = {
  id: 145,
  name: 'Battle Fury',
  dname: 'item_bfury',
  shortName: 'bfury',
  cost: 4100,
  isPurchasable: true,
  isStackable: false,
  isSideShop: false,
  stockMax: 0,
  isSupportFullItem: false,
  image: 'battle_fury_lg.png?3',
  components: [],
};

describe('BuildItemRow', () => {
  it('renders the metadata image beside the item name using the configured CDN', () => {
    const html = renderToStaticMarkup(<BuildItemRow item={item} metadata={metadata} />);

    expect(html).toContain(`src="${APP_CONFIG.cdnBase}/apps/dota2/images/items/${metadata.image}"`);
    expect(html).toContain('alt=""');
    expect(html).toContain('aspect-square');
    expect(html).toContain('Battle Fury');
    expect(html.indexOf('<img')).toBeLessThan(html.indexOf('Battle Fury'));
  });

  it('keeps the item name and omits the image when metadata has no image', () => {
    const html = renderToStaticMarkup(
      <BuildItemRow item={item} metadata={{ ...metadata, image: '' }} />,
    );

    expect(html).toContain('Battle Fury');
    expect(html).not.toContain('<img');
  });

  it('hides a failed image while keeping the item name', () => {
    const row = BuildItemRow({ item, metadata });
    const imageElement = Children.toArray(row.props.children)[0];
    expect(isValidElement(imageElement)).toBe(true);
    if (!isValidElement<{ onError: ReactEventHandler<HTMLImageElement> }>(imageElement)) {
      throw new Error('Expected the item row to render its image element.');
    }
    const style = { display: 'block' };
    imageElement.props.onError({
      currentTarget: { style },
    } as SyntheticEvent<HTMLImageElement>);
    const html = renderToStaticMarkup(<BuildItemRow item={item} metadata={metadata} />);

    expect(html).toContain('Battle Fury');
    expect(style.display).toBe('none');
  });

  it('renders an unknown item metadata entry safely as Item #<id>', () => {
    const html = renderToStaticMarkup(<BuildItemRow item={{ itemId: 987654, rank: 1 }} />);

    expect(html).toContain('Item #987654');
    expect(html).not.toContain('<img');
  });

  it('preserves the order supplied by the build', () => {
    const html = renderToStaticMarkup(
      <ul>
        <BuildItemRow item={{ itemId: 145, rank: 1 }} metadata={metadata} />
        <BuildItemRow item={{ itemId: 1, rank: 2 }} metadata={{ ...metadata, id: 1, name: 'Blink Dagger' }} />
      </ul>,
    );

    expect(html.indexOf('Battle Fury')).toBeLessThan(html.indexOf('Blink Dagger'));
  });

  it('renders item images for Puck, Juggernaut and Crystal Maiden, including collapsed General', () => {
    const dataset: BuildEngineDataset = {
      heroes: heroesData.map((hero) => ({ ...hero, nameRu: '' })),
      positions: positionsData,
      items: itemsData,
      itemStats: itemStatsData,
    };
    const engine = createBuildEngine(dataset);
    const cases = [
      ['Puck', '2'],
      ['Juggernaut', '1'],
      ['Crystal Maiden', '5'],
    ] as const;

    for (const [heroName, position] of cases) {
      const hero = dataset.heroes.find(({ name }) => name === heroName);
      expect(hero).toBeDefined();
      const build = engine.getBuild(hero!.id, position);
      expect(build.status).toBe('ready');

      const html = renderToStaticMarkup(
        <RecommendedBuildPanel
          heroId={hero!.id}
          initialPosition={position}
          buildEngine={engine}
          items={dataset.items}
        />,
      );
      const expectedImageCount = build.items.filter((entry) => dataset.items[entry.itemId]?.image).length;
      expect(html.match(/<img\b/g) ?? []).toHaveLength(expectedImageCount);
      for (const entry of build.items) {
        const itemMetadata = dataset.items[entry.itemId];
        expect(html.replace(/&#x27;/g, "'")).toContain(itemMetadata?.name ?? `Item #${entry.itemId}`);
      }

      if (heroName === 'Juggernaut') {
        const generalItems = build.items.filter((buildItem) => buildItem.phase === 'general');
        expect(generalItems.length).toBeGreaterThan(0);
        const details = html.match(/<details class="panel-2 mt-4">([\s\S]*?)<\/details>/)?.[1];
        expect(html).not.toMatch(/<details[^>]* open/);
        expect(details).toBeDefined();
        expect(details).toContain('<img');
        expect(details?.match(/<li/g)).toHaveLength(generalItems.length);

        const renderedRanks = [...html.matchAll(/title="ItemPrior presentation rank">Prior #(\d+)/g)]
          .map((match) => Number(match[1]));
        expect(renderedRanks).toEqual(build.items.map(({ rank }) => rank));
      }
    }
  });
});
