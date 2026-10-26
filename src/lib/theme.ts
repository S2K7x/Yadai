/**
 * Themes: a few named presets, two user-chosen accents, everything else
 * derived.
 *
 * The rule that keeps this small: a preset declares ten base colours per mode
 * and nothing more. Hovers, borders, faint text, soft accent washes and the
 * assistant bubble are all computed from those with `color-mix(in oklab, …)`,
 * so picking a new accent cannot leave a stale hover behind — there is only
 * one place a colour is written down.
 *
 * Two things are *not* left to CSS, because they need arithmetic no stylesheet
 * can do: which ink is readable on a colour, and how far an accent must be
 * deepened before white text on it passes 4.5:1. Both are pure functions here,
 * measured with the WCAG relative-luminance formula and tested.
 *
 * This module must stay browser-agnostic: the server route validates a saved
 * theme with `normalizeTheme`, and the store turns it into inline custom
 * properties with `themeVariables`.
 */

export type ThemeMode = 'dark' | 'light';

export interface ThemeSettings {
	preset: string;
	mode: ThemeMode;
	/** `null` means "whatever the preset says". */
	accent: string | null;
	accent2: string | null;
}

export interface PresetPalette {
	bg: string;
	surface: string;
	sunken: string;
	text: string;
	muted: string;
	accent: string;
	accent2: string;
	/** The dark icon rail, and the deep tone everything is deepened toward. */
	rail: string;
	danger: string;
	ok: string;
}

export interface ThemePreset {
	id: string;
	name: string;
	hint: string;
	dark: PresetPalette;
	light: PresetPalette;
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

export const PRESETS: ThemePreset[] = [
	{
		id: 'terracotta',
		name: 'Terracotta',
		hint: 'Cream and orange, floating panels',
		dark: {
			bg: '#141312',
			surface: '#221f1c',
			sunken: '#191614',
			text: '#f2ebe2',
			muted: '#a79c91',
			accent: '#ee7c2b',
			accent2: '#a6be79',
			rail: '#17130f',
			danger: '#e0705a',
			ok: '#86ae62'
		},
		light: {
			bg: '#dcdbd9',
			surface: '#fdfbf7',
			sunken: '#f5f1ea',
			text: '#2c211b',
			muted: '#7a6e64',
			accent: '#ee7c2b',
			accent2: '#a6be79',
			rail: '#2e211b',
			danger: '#d2563f',
			ok: '#6e9a4e'
		}
	},
	{
		id: 'ardoise',
		name: 'Slate',
		hint: "The app's original palette",
		dark: {
			bg: '#1c1b19',
			surface: '#262523',
			sunken: '#151412',
			text: '#f0eee6',
			muted: '#a5a196',
			accent: '#d97757',
			accent2: '#6f9c86',
			rail: '#121110',
			danger: '#e05252',
			ok: '#5fa85f'
		},
		light: {
			bg: '#eceadf',
			surface: '#ffffff',
			sunken: '#f0eee6',
			text: '#26241f',
			muted: '#63605a',
			accent: '#c25f3c',
			accent2: '#4f8570',
			rail: '#26241f',
			danger: '#cc3333',
			ok: '#3f7d3f'
		}
	},
	{
		id: 'nocturne',
		name: 'Nocturne',
		hint: 'Deep blue, indigo accent',
		dark: {
			bg: '#0f1117',
			surface: '#191c25',
			sunken: '#12141b',
			text: '#e7e9f2',
			muted: '#9aa0b5',
			accent: '#6d8cff',
			accent2: '#4fbfa8',
			rail: '#0b0d13',
			danger: '#e05a6b',
			ok: '#4fbf87'
		},
		light: {
			bg: '#dfe1e8',
			surface: '#ffffff',
			sunken: '#f1f3f8',
			text: '#1c1f2a',
			muted: '#656b7e',
			accent: '#4c67e0',
			accent2: '#2f9c88',
			rail: '#1c1f2a',
			danger: '#cc3f52',
			ok: '#2f8f5e'
		}
	},
	{
		id: 'verger',
		name: 'Orchard',
		hint: 'Forest green and honey',
		dark: {
			bg: '#101410',
			surface: '#1b211b',
			sunken: '#141914',
			text: '#eaf0e6',
			muted: '#9aa895',
			accent: '#7fae52',
			accent2: '#d9a03c',
			rail: '#0d120d',
			danger: '#d9624c',
			ok: '#7fae52'
		},
		light: {
			bg: '#dcdfd6',
			surface: '#fbfcf7',
			sunken: '#eef1e8',
			text: '#232a20',
			muted: '#67705f',
			accent: '#5e8f37',
			accent2: '#c07c22',
			rail: '#232a20',
			danger: '#c0503c',
			ok: '#5e8f37'
		}
	},

	// ---------------------------------------------------------------------
	// The poster palettes.
	//
	// Lifted from a fifteen-poster colour study, sampled pixel by pixel rather
	// than eyeballed. A poster is two colours — a flat ground and the wordmark
	// printed on it — which is exactly the pair this app calls `accent` and
	// `accent2`; whichever of the two reads as a highlight leads, so a poster
	// with a dark ground (Pinede, Outremer) hands the lead to its wordmark.
	//
	// The eight remaining colours are NOT from the posters: a full-bleed
	// saturated ground is a poster, not a page you read for an hour. They are
	// neutral anchors tinted toward the poster's own colour, so each preset
	// carries its hue into the surfaces without ever colouring the text. Every
	// one of them is checked by `tests/theme.test.ts` — text at 4.5:1 on its
	// own surface, muted at 3:1, and a focus ring that clears all three
	// backgrounds whatever accent the user then types in.
	// ---------------------------------------------------------------------
	{
		id: 'corail',
		name: 'Coral',
		hint: 'Warm coral, midnight-blue ink',
		dark: {
			bg: '#1d1718',
			surface: '#2f2627',
			sunken: '#211b1c',
			text: '#f0eced',
			muted: '#a59da2',
			accent: '#f48773',
			accent2: '#4a6f9c',
			rail: '#1f1615',
			danger: '#e1715c',
			ok: '#68ae82'
		},
		light: {
			bg: '#e2d1cf',
			surface: '#fdf7f5',
			sunken: '#f1e4e1',
			text: '#372e31',
			muted: '#7b7176',
			accent: '#f48773',
			accent2: '#4a6f9c',
			rail: '#3f3234',
			danger: '#cc533f',
			ok: '#4a8a64'
		}
	},
	{
		id: 'creme',
		name: 'Cream',
		hint: 'Cream paper and sage',
		dark: {
			bg: '#1a1a1a',
			surface: '#2b2a2a',
			sunken: '#1e1e1e',
			text: '#eeeeef',
			muted: '#a0a3a6',
			accent: '#9aae76',
			accent2: '#5b7186',
			rail: '#1b1b19',
			danger: '#df745e',
			ok: '#65b184'
		},
		light: {
			bg: '#dbd9d6',
			surface: '#fafaf7',
			sunken: '#eceae6',
			text: '#333335',
			muted: '#75777a',
			accent: '#9aae76',
			accent2: '#5b7186',
			rail: '#39393a',
			danger: '#c95642',
			ok: '#478d66'
		}
	},
	{
		id: 'pinede',
		name: 'Pinewood',
		hint: 'Deep fir green, sky accent',
		dark: {
			bg: '#0f1416',
			surface: '#1a2124',
			sunken: '#13181a',
			text: '#e5e9eb',
			muted: '#8b989f',
			accent: '#6fb3ea',
			accent2: '#2e9188',
			rail: '#0a1213',
			danger: '#d36f5a',
			ok: '#5aab80'
		},
		light: {
			bg: '#bccacb',
			surface: '#f1f5f4',
			sunken: '#d5dfdd',
			text: '#20292e',
			muted: '#5f6b72',
			accent: '#6fb3ea',
			accent2: '#2e9188',
			rail: '#1f2b30',
			danger: '#be513e',
			ok: '#3c8762'
		}
	},
	{
		id: 'lagune',
		name: 'Lagoon',
		hint: 'Teal and sky blue',
		dark: {
			bg: '#101617',
			surface: '#1c2426',
			sunken: '#141a1b',
			text: '#e6ebec',
			muted: '#8e9ba1',
			accent: '#33a096',
			accent2: '#6eb2e9',
			rail: '#0c1415',
			danger: '#d5705b',
			ok: '#5bac82'
		},
		light: {
			bg: '#c0cdce',
			surface: '#f2f6f5',
			sunken: '#d8e2e0',
			text: '#222c31',
			muted: '#616e75',
			accent: '#33a096',
			accent2: '#6eb2e9',
			rail: '#222f33',
			danger: '#bf523f',
			ok: '#3d8963'
		}
	},
	{
		id: 'brume',
		name: 'Mist',
		hint: 'Dusty blue and mint',
		dark: {
			bg: '#15191c',
			surface: '#23282d',
			sunken: '#191d20',
			text: '#eaedf0',
			muted: '#97a0aa',
			accent: '#5f9cb8',
			accent2: '#4fc7a3',
			rail: '#13191b',
			danger: '#d97360',
			ok: '#60af86'
		},
		light: {
			bg: '#cdd5da',
			surface: '#f6f8f9',
			sunken: '#e2e8e9',
			text: '#2a3138',
			muted: '#6b747e',
			accent: '#5f9cb8',
			accent2: '#4fc7a3',
			rail: '#2d363e',
			danger: '#c45543',
			ok: '#428b68'
		}
	},
	{
		id: 'abricot',
		name: 'Apricot',
		hint: 'Soft apricot and coral',
		dark: {
			bg: '#1d1c19',
			surface: '#302c29',
			sunken: '#211f1d',
			text: '#f1efee',
			muted: '#a6a6a5',
			accent: '#f5b95e',
			accent2: '#dd7660',
			rail: '#201d18',
			danger: '#e2765d',
			ok: '#69b284'
		},
		light: {
			bg: '#e3ddd4',
			surface: '#fdfbf6',
			sunken: '#f3ede4',
			text: '#383534',
			muted: '#7c7a79',
			accent: '#f5b95e',
			accent2: '#dd7660',
			rail: '#413c38',
			danger: '#cc5841',
			ok: '#4b8e66'
		}
	},
	{
		id: 'framboise',
		name: 'Raspberry',
		hint: 'Raspberry pink and apricot',
		dark: {
			bg: '#1b1519',
			surface: '#2c2329',
			sunken: '#1f191d',
			text: '#efeaee',
			muted: '#a29aa5',
			accent: '#db6b8c',
			accent2: '#f6c072',
			rail: '#1d1418',
			danger: '#e0705d',
			ok: '#66ac84'
		},
		light: {
			bg: '#deccd3',
			surface: '#fbf6f6',
			sunken: '#eee1e4',
			text: '#352b34',
			muted: '#786e79',
			accent: '#db6b8c',
			accent2: '#f6c072',
			rail: '#3c2e38',
			danger: '#ca5241',
			ok: '#488865'
		}
	},
	{
		id: 'menthe',
		name: 'Mint',
		hint: 'Light mint, ultramarine accent',
		dark: {
			bg: '#171d1d',
			surface: '#262e2e',
			sunken: '#1b2121',
			text: '#ecf1f1',
			muted: '#9ba8ac',
			accent: '#45c39a',
			accent2: '#3a5cc4',
			rail: '#171f1d',
			danger: '#dc7761',
			ok: '#62b387'
		},
		light: {
			bg: '#d3e0dd',
			surface: '#f8fcfa',
			sunken: '#e6f0ec',
			text: '#2e383a',
			muted: '#707d80',
			accent: '#45c39a',
			accent2: '#3a5cc4',
			rail: '#333f41',
			danger: '#c65945',
			ok: '#449069'
		}
	},
	{
		id: 'ambre',
		name: 'Amber',
		hint: 'Midnight slate and amber yellow',
		dark: {
			bg: '#111316',
			surface: '#1d1f24',
			sunken: '#15171a',
			text: '#e6e8eb',
			muted: '#8f969f',
			accent: '#ecbf3d',
			accent2: '#7fa8c4',
			rail: '#0d1013',
			danger: '#d56d5a',
			ok: '#5ca980'
		},
		light: {
			bg: '#c2c6cb',
			surface: '#f3f4f4',
			sunken: '#dadcde',
			text: '#23272f',
			muted: '#636972',
			accent: '#ecbf3d',
			accent2: '#7fa8c4',
			rail: '#242830',
			danger: '#c04f3e',
			ok: '#3e8662'
		}
	},
	{
		id: 'dragee',
		name: 'Blush',
		hint: 'Sugared-almond pink and teal',
		dark: {
			bg: '#1c191d',
			surface: '#2e292e',
			sunken: '#201d21',
			text: '#f0eef1',
			muted: '#a4a1ac',
			accent: '#e58cb2',
			accent2: '#2f8d7e',
			rail: '#1f191d',
			danger: '#e17461',
			ok: '#68b087'
		},
		light: {
			bg: '#e1d7dd',
			surface: '#fcf9fa',
			sunken: '#f1e9eb',
			text: '#37323a',
			muted: '#7a7580',
			accent: '#e58cb2',
			accent2: '#2f8d7e',
			rail: '#3f3740',
			danger: '#cb5645',
			ok: '#4a8c69'
		}
	},
	{
		id: 'brique',
		name: 'Brick',
		hint: 'Burnt terracotta and orange',
		dark: {
			bg: '#181313',
			surface: '#271f20',
			sunken: '#1c1717',
			text: '#ece8e9',
			muted: '#9c969a',
			accent: '#c55b39',
			accent2: '#f2a63c',
			rail: '#18100f',
			danger: '#dc6d57',
			ok: '#63a97e'
		},
		light: {
			bg: '#d5c6c3',
			surface: '#f9f4f1',
			sunken: '#e8dcd8',
			text: '#2f272a',
			muted: '#71696d',
			accent: '#c55b39',
			accent2: '#f2a63c',
			rail: '#34282a',
			danger: '#c74f3b',
			ok: '#45865f'
		}
	},
	{
		id: 'outremer',
		name: 'Ultramarine',
		hint: 'Ultramarine and sky',
		dark: {
			bg: '#101219',
			surface: '#1b1e29',
			sunken: '#14161d',
			text: '#e6e8ee',
			muted: '#8d94a5',
			accent: '#4a6ee0',
			accent2: '#70b1ed',
			rail: '#0c0f17',
			danger: '#d46d5d',
			ok: '#5ba983'
		},
		light: {
			bg: '#bfc4d3',
			surface: '#f2f3f6',
			sunken: '#d8dbe4',
			text: '#222634',
			muted: '#616778',
			accent: '#4a6ee0',
			accent2: '#70b1ed',
			rail: '#212737',
			danger: '#bf4f41',
			ok: '#3d8565'
		}
	}
];

export const DEFAULT_PRESET = 'terracotta';

export const DEFAULT_THEME: ThemeSettings = {
	preset: DEFAULT_PRESET,
	mode: 'dark',
	accent: null,
	accent2: null
};

export const presetById = (id: string): ThemePreset =>
	PRESETS.find((p) => p.id === id) ?? PRESETS[0];

// ---------------------------------------------------------------------------
// Colour arithmetic
// ---------------------------------------------------------------------------

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** `#ABC` / `abcdef` / `#ABCDEF` → `#abcdef`; anything else → `null`. */
export function normalizeHex(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const match = HEX.exec(value.trim());
	if (!match) return null;
	const body = match[1].toLowerCase();
	const full =
		body.length === 3
			? body
					.split('')
					.map((c) => c + c)
					.join('')
			: body;
	return `#${full}`;
}

function channels(hex: string): [number, number, number] {
	const clean = normalizeHex(hex) ?? '#000000';
	return [
		parseInt(clean.slice(1, 3), 16),
		parseInt(clean.slice(3, 5), 16),
		parseInt(clean.slice(5, 7), 16)
	];
}

const toHex = (n: number) =>
	Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');

/** Straight sRGB channel blend. `t = 0` keeps `a`, `t = 1` gives `b`. */
export function mixHex(a: string, b: string, t: number): string {
	const [ar, ag, ab] = channels(a);
	const [br, bg, bb] = channels(b);
	const k = Math.max(0, Math.min(1, t));
	return `#${toHex(ar + (br - ar) * k)}${toHex(ag + (bg - ag) * k)}${toHex(ab + (bb - ab) * k)}`;
}

const linear = (c: number) => {
	const s = c / 255;
	return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

/** `#rrggbb` at an alpha, for a shadow that is a colour rather than a grey. */
export function rgba(hex: string, alpha: number): string {
	const [r, g, b] = channels(hex);
	return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** WCAG relative luminance, 0 (black) … 1 (white). */
export function luminance(hex: string): number {
	const [r, g, b] = channels(hex);
	return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG contrast ratio, 1 … 21. */
export function contrastRatio(a: string, b: string): number {
	const la = luminance(a);
	const lb = luminance(b);
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Whichever of the two inks is more readable on `background`. */
export function readableInk(background: string, dark = '#1b1613', light = '#ffffff'): string {
	return contrastRatio(background, dark) >= contrastRatio(background, light) ? dark : light;
}

/**
 * Deepen `color` toward `toward` just far enough that `ink` on it reaches
 * `target`, and no further.
 *
 * This is what lets the user bubble be white-on-accent whatever accent the
 * user picks: a bright orange is walked a third of the way to the palette's
 * deepest tone — still unmistakably the accent — while an already-dark accent
 * is left alone. Without it, "white text on the accent" silently becomes
 * unreadable the moment someone picks a yellow.
 */
export function ensureContrast(color: string, ink: string, toward: string, target = 4.5): string {
	for (let t = 0; t <= 1.0001; t += 0.05) {
		const candidate = mixHex(color, toward, t);
		if (contrastRatio(candidate, ink) >= target) return candidate;
	}
	return toward;
}

/**
 * Nudge `color` toward `toward` until it is visible on *every* surface it can
 * be drawn on.
 *
 * This is the focus ring. WCAG 1.4.11 asks 3:1 for a control's visual
 * indicator, and the accent alone does not always give it: a deep indigo on
 * the near-black background of "Nocturne", or any dark colour the user types
 * into the accent field, would draw a ring nobody can see. Walking it toward
 * the text ink keeps it recognisably the accent while making it stand out —
 * and `toward` is the fallback, since text on its own surfaces is what the
 * presets already guarantee.
 */
export function ensureVisible(
	color: string,
	backgrounds: string[],
	toward: string,
	target = 3
): string {
	for (let t = 0; t <= 1.0001; t += 0.05) {
		const candidate = mixHex(color, toward, t);
		if (backgrounds.every((bg) => contrastRatio(candidate, bg) >= target)) return candidate;
	}
	return toward;
}

/** What the settings panel shows next to a colour input. */
export interface Readability {
	ink: string;
	ratio: number;
	/** WCAG AA for body text. */
	ok: boolean;
}

export function readability(color: string): Readability {
	const ink = readableInk(color);
	const ratio = contrastRatio(color, ink);
	return { ink, ratio: Math.round(ratio * 100) / 100, ok: ratio >= 4.5 };
}

// ---------------------------------------------------------------------------
// Settings → CSS custom properties
// ---------------------------------------------------------------------------

export function normalizeTheme(raw: unknown): ThemeSettings {
	const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	const preset =
		typeof o.preset === 'string' && PRESETS.some((p) => p.id === o.preset)
			? o.preset
			: DEFAULT_PRESET;
	return {
		preset,
		mode: o.mode === 'light' ? 'light' : 'dark',
		accent: normalizeHex(o.accent),
		accent2: normalizeHex(o.accent2)
	};
}

/** The colours a preset would give, once the user's overrides are applied. */
export function effectivePalette(settings: ThemeSettings): PresetPalette {
	const preset = presetById(settings.preset);
	const base = settings.mode === 'light' ? preset.light : preset.dark;
	return {
		...base,
		accent: settings.accent ?? base.accent,
		accent2: settings.accent2 ?? base.accent2
	};
}

const mix = (a: string, b: string, pct: number) =>
	`color-mix(in oklab, ${a} ${100 - pct}%, ${b} ${pct}%)`;

/**
 * Every themed custom property, ready to be set on `<html>`.
 *
 * `app.css` declares the same names with literal defaults so the very first
 * paint of a fresh browser is not colourless; this map overrides them inline.
 * A token that exists in the stylesheet but not here would never follow a
 * preset change — `tests/theme.test.ts` reads `app.css` to make sure none
 * does.
 */
export function themeVariables(raw: unknown): Record<string, string> {
	const settings = normalizeTheme(raw);
	const p = effectivePalette(settings);
	const dark = settings.mode === 'dark';

	// Dark surfaces need a firmer nudge than light ones to read as a change.
	const step = dark
		? { hover: 11, border: 19, borderSoft: 11, bubble: 9, soft: 22, faint: 38 }
		: { hover: 7, border: 13, borderSoft: 8, bubble: 7, soft: 16, faint: 34 };

	// `palette.rail` is the deepest tone of the palette. In light mode that is
	// exactly what the icon column wants — a dark bar on a pale page. In dark
	// mode it would be a near-black column on a near-black page, invisible, so
	// the rail is raised *above* the surface there instead. `p.rail` stays the
	// anchor everything is deepened toward either way.
	const rail = dark ? mixHex(p.surface, p.text, 0.07) : p.rail;
	const railInk = readableInk(rail);
	// What a shadow is made of. A dark page has nothing darker than black to
	// cast with; a pale one casts in its own deep tone, which is what keeps a
	// warm palette's shadows warm and a cool one's cool.
	const cast = dark ? '#000000' : p.rail;

	return {
		'--bg': p.bg,
		'--bg-raised': p.surface,
		'--bg-sunken': p.sunken,
		'--bg-hover': mix(p.surface, p.text, step.hover),
		'--border': mix(p.surface, p.text, step.border),
		'--border-soft': mix(p.surface, p.text, step.borderSoft),
		'--text': p.text,
		'--text-muted': p.muted,
		'--text-faint': mix(p.muted, p.bg, step.faint),
		'--accent': p.accent,
		'--accent-ink': readableInk(p.accent),
		'--accent-soft': mix(p.surface, p.accent, step.soft),
		// The keyboard focus ring, drawn on the page, on a panel and on the
		// sunken fields alike — hence the three backgrounds.
		'--focus': ensureVisible(p.accent, [p.surface, p.bg, p.sunken], p.text),
		'--accent-2': p.accent2,
		'--accent-2-ink': readableInk(p.accent2),
		'--accent-2-soft': mix(p.surface, p.accent2, step.soft),
		'--danger': p.danger,
		'--danger-soft': mix(p.surface, p.danger, step.soft),
		'--ok': p.ok,
		'--code-bg': p.sunken,
		// The user bubble is the accent, deepened only as much as white text
		// requires — see `ensureContrast`.
		'--user-bubble': ensureContrast(p.accent, '#ffffff', p.rail),
		'--user-ink': '#ffffff',
		// The far end of the welcome card's gradient. It is the *second* accent
		// put through the same deepening, which is what lets that card run
		// between two real hues instead of one: white is guaranteed readable at
		// both ends, because both ends are colours `ensureContrast` has already
		// walked down until it was.
		'--hero-2': ensureContrast(p.accent2, '#ffffff', p.rail),
		'--assistant-bubble': mix(p.surface, p.text, step.bubble),
		'--rail': rail,
		'--rail-ink': railInk,
		'--rail-hover': mix(rail, railInk, 14),
		// Elevation is what separates a card from the page here: this design
		// draws no strokes, so the shadow is the edge. Three levels — a resting
		// card, a panel, and the things that hover over both (the composer, a
		// popup, the send button) — and all three are cast in the palette's own
		// deepest tone rather than in neutral black, so a shadow belongs to its
		// preset instead of greying it.
		'--shadow-card': dark ? `0 2px 12px ${rgba(cast, 0.34)}` : `0 4px 14px ${rgba(cast, 0.07)}`,
		'--shadow': dark ? `0 8px 28px ${rgba(cast, 0.45)}` : `0 10px 30px ${rgba(cast, 0.1)}`,
		'--shadow-float': dark ? `0 14px 36px ${rgba(cast, 0.55)}` : `0 14px 34px ${rgba(cast, 0.16)}`,
		'--scrim': dark ? rgba(cast, 0.58) : rgba(p.rail, 0.35)
	};
}

/** What goes in `<meta name="theme-color">`: the page background. */
export const themeColor = (raw: unknown): string => effectivePalette(normalizeTheme(raw)).bg;

// ---------------------------------------------------------------------------
// Writing a change back
// ---------------------------------------------------------------------------

/**
 * The settings a change may be composed on top of, or `null` while unknown.
 *
 * Same shape and same reason as `PromptBaseline`: `PUT /api/theme` is a
 * replace-all, so building a patch on `DEFAULT_THEME` when the GET never
 * answered does not "fall back to the defaults" — it *writes* them over the
 * palette the user actually chose.
 */
export type ThemeBaseline = ThemeSettings | null;

export type ThemeWriteResult =
	| { ok: true; settings: ThemeSettings }
	| { ok: false; reason: 'unloaded' };

/** Compose a change, or refuse when there is nothing trustworthy to build on. */
export function planThemeUpdate(
	base: ThemeBaseline,
	patch: Partial<ThemeSettings>
): ThemeWriteResult {
	if (base === null) return { ok: false, reason: 'unloaded' };
	return { ok: true, settings: normalizeTheme({ ...base, ...patch }) };
}

/**
 * The settings behind the pre-paint cache, or `null` when it holds none.
 *
 * The cached blob exists for the inline script in `app.html`, which replays
 * `vars` and needs no logic of its own; `settings` rides along so that after a
 * failed load the panel can still show which palette is on screen instead of
 * highlighting the default one. It is deliberately NOT a baseline: it says
 * what this device painted last, not what the server holds.
 *
 * Returns `null` — never `DEFAULT_THEME` — for a missing, corrupt or
 * older-format cache, because "no idea" and "the defaults" are the two states
 * that must not be confused here.
 */
export function cachedTheme(raw: string | null | undefined): ThemeSettings | null {
	if (!raw) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== 'object') return null;
	const settings = (parsed as { settings?: unknown }).settings;
	if (!settings || typeof settings !== 'object') return null;
	return normalizeTheme(settings);
}
