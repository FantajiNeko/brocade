import { SUBSCRIPTION_COUNTRY_CODES } from './subscription-country';

export const CUSTOM_REGION_CODE = 'XX';

export interface RegionGroup {
  id: string;
  label: string;
  codes: string[];
}

const SPECIAL_CODES = [CUSTOM_REGION_CODE, 'EU', 'UN', 'PC', 'XK', 'CP', 'DG', 'IC'];
const SPECIAL_CODE_SET = new Set(SPECIAL_CODES);

// 大洲归属沿用 CLDR territory containment。跨洲国家按 CLDR 的单一归属展示；不是
// ISO 3166-1 正式地区的旗位留到「特殊」，避免把 EU、UN 或自定义位伪装成国家。
const CONTINENT_CODES = [
  {
    id: 'asia',
    label: '亚洲',
    codes:
      'AE AF AM AZ BD BH BN BT CN CY GE HK ID IL IN IQ IR JO JP KG KH KP KR KW KZ LA LB LK MM MN MO MV MY NP OM PH PK PS QA SA SG SY TH TJ TL TM TR TW UZ VN YE',
  },
  {
    id: 'europe',
    label: '欧洲',
    codes:
      'AD AL AT AX BA BE BG BY CH CZ DE DK EE ES FI FO FR GB GG GI GR HR HU IE IM IS IT JE LI LT LU LV MC MD ME MK MT NL NO PL PT RO RS RU SE SI SJ SK SM UA VA',
  },
  {
    id: 'north-america',
    label: '北美洲',
    codes:
      'AG AI AW BB BL BM BQ BS BZ CA CR CU CW DM DO GD GL GP GT HN HT JM KN KY LC MF MQ MS MX NI PA PM PR SV SX TC TT US VC VG VI',
  },
  {
    id: 'south-america',
    label: '南美洲',
    codes: 'AR BO BR BV CL CO EC FK GF GS GY PE PY SR UY VE',
  },
  {
    id: 'africa',
    label: '非洲',
    codes:
      'AO BF BI BJ BW CD CF CG CI CM CV DJ DZ EG EH ER ET GA GH GM GN GQ GW IO KE KM LR LS LY MA MG ML MR MU MW MZ NA NE NG RE RW SC SD SH SL SN SO SS ST SZ TD TF TG TN TZ UG YT ZA ZM ZW',
  },
  {
    id: 'oceania',
    label: '大洋洲',
    codes: 'AS AU CC CK CX FJ FM GU HM KI MH MP NC NF NR NU NZ PF PG PN PW SB TK TO TV UM VU WF WS',
  },
  { id: 'antarctica', label: '南极洲', codes: 'AQ' },
] as const;

const available = new Set(SUBSCRIPTION_COUNTRY_CODES);
const assigned = new Set<string>();

export const REGION_GROUPS: RegionGroup[] = CONTINENT_CODES.map(group => {
  const codes = group.codes
    .split(' ')
    .filter(code => available.has(code) && !SPECIAL_CODE_SET.has(code) && !assigned.has(code));
  codes.forEach(code => assigned.add(code));
  return { id: group.id, label: group.label, codes };
});

const special = [
  ...SPECIAL_CODES.filter(code => available.has(code)),
  // 新版旗帜资源若增加非大洲代码，先显示在特殊区，避免升级后悄悄少旗。
  ...SUBSCRIPTION_COUNTRY_CODES.filter(code => !assigned.has(code) && !SPECIAL_CODE_SET.has(code)),
];
REGION_GROUPS.push({ id: 'special', label: '特殊', codes: special });
