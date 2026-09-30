/**
 * Provider expiry table.
 *
 * This is a DATA ASSET, not a switch statement. It is the seed of the paid
 * product: the free tool reads it to say "this could expire", the paid product
 * reads the same table plus a live connection to say "this expires Tuesday".
 *
 * Rules for editing this file:
 *  1. Every `window` and every `condition` needs a `sources` URL. No folklore.
 *  2. If we cannot know the condition from a pasted JSON, say so in `certainty:
 *     'conditional'` and give `howToCheck`. Never predict what we cannot see.
 *  3. Adding a provider must never require touching a check.
 *  4. `windowSeconds` and `countsFrom` say what `window` says, as numbers.
 *     A window with no fixed length is `null`, never a guess.
 *
 * Exported since 2.3.0, frozen: it is public, and analyze() reads the same
 * objects, so a consumer must not be able to change what the checks see.
 */

import type { AuthKind } from './model.js';

const DAY = 86_400;

export interface ExpiryRule {
  /** The situation in which this window applies, in plain words. */
  readonly condition: string;
  /** 'certain'     - true for every connection of this type.
   *  'conditional' - depends on something not visible in the export. */
  readonly certainty: 'certain' | 'conditional';
  /** e.g. '7 days', '60 days', 'never'. */
  readonly window: string;
  /**
   * `window` as a number, for code that forecasts a date: the longest this
   * rule lets the credential live, in seconds. `null` when the rule sets no
   * fixed length ('never', 'indefinite', a policy the export can't show).
   */
  readonly windowSeconds: number | null;
  /**
   * What `windowSeconds` counts from: `'issued'` (consent, or the token being
   * generated) or `'last-use'` (it expires from disuse). `null` exactly when
   * `windowSeconds` is.
   */
  readonly countsFrom: 'issued' | 'last-use' | null;
  readonly detail: string;
  /** How the reader confirms it themselves, in under a minute. */
  readonly howToCheck?: string;
}

export interface Provider {
  /** Stable key, e.g. 'google'. What `CredentialRef.providerId` holds. */
  readonly id: string;
  readonly displayName: string;
  /** Substring matchers against the raw credential type, lower-cased. */
  readonly match: {
    readonly n8n: readonly string[];
    readonly make: readonly string[];
  };
  readonly defaultAuthKind: AuthKind;
  /** Can the platform silently refresh this without a human? */
  readonly autoRefreshable: boolean;
  /** The first rule is the one the credential-expiry finding leads with. */
  readonly rules: readonly ExpiryRule[];
  readonly sources: readonly string[];
  /** Complaint Mine Log row numbers backing this entry. Evidence, not vibes. */
  readonly complaintLogRows?: readonly number[];
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

export const PROVIDERS: readonly Provider[] = deepFreeze<Provider[]>([
  {
    id: 'google',
    displayName: 'Google',
    match: {
      n8n: [
        'googlesheetsoauth2',
        'googledriveoauth2',
        'gmailoauth2',
        'googlecalendaroauth2',
        'googledocsoauth2',
        'googleoauth2',
        'gsuiteadminoauth2',
        'googlebigqueryoauth2',
        'googleanalyticsoauth2',
      ],
      make: ['account:google', 'google'],
    },
    defaultAuthKind: 'oauth2',
    autoRefreshable: true,
    rules: [
      {
        condition:
          'The Google Cloud project behind this connection has its OAuth consent screen set to "Testing" with an External user type',
        certainty: 'conditional',
        window: '7 days',
        windowSeconds: 7 * DAY,
        countsFrom: 'issued',
        detail:
          'Google issues a refresh token that expires 7 days after consent. When it dies the platform gets invalid_grant, the trigger stops firing, and nothing throws a run-level error because there is no run.',
        howToCheck:
          'Google Cloud Console -> APIs & Services -> OAuth consent screen. If Publishing status says "Testing", this connection dies every 7 days. If it says "In production", it does not.',
      },
      {
        condition: 'The consent screen is published to production and verified',
        certainty: 'conditional',
        window: 'indefinite, with five exceptions',
        windowSeconds: null,
        countsFrom: null,
        detail:
          'Effectively permanent unless: the token goes unused for six months, the user revokes access, the user changes their password while Gmail scopes are granted, the per-user token cap is exceeded, or the app loses verification for sensitive scopes.',
        howToCheck:
          'The six-month rule matters here: a workflow that stops running also stops refreshing, so a quiet workflow eventually becomes a dead credential.',
      },
    ],
    sources: [
      'https://developers.google.com/identity/protocols/oauth2',
      'https://support.google.com/cloud/answer/15549945',
    ],
    complaintLogRows: [9, 11, 12, 40, 41],
  },
  {
    id: 'microsoft',
    displayName: 'Microsoft',
    match: {
      n8n: [
        'microsoftoauth2',
        'microsoftoutlookoauth2',
        'microsoftexceloauth2',
        'microsoftonedriveoauth2',
        'microsoftsharepointoauth2',
        'microsoftteamsoauth2',
        'microsoftgraphsecurityoauth2',
        'azure',
      ],
      make: ['account:microsoft', 'microsoft', 'office365'],
    },
    defaultAuthKind: 'oauth2',
    autoRefreshable: true,
    rules: [
      {
        condition: 'Normal case — the workflow runs at least every 90 days',
        certainty: 'certain',
        window: 'effectively indefinite',
        windowSeconds: null,
        countsFrom: null,
        detail:
          'Microsoft refresh tokens default to a 90-day inactivity limit and replace themselves every time they are used. A workflow that runs daily keeps resetting the clock, so this is lower risk than Google.',
      },
      {
        condition: 'The workflow stops running for 90 days',
        certainty: 'certain',
        window: '90 days of inactivity',
        windowSeconds: 90 * DAY,
        countsFrom: 'last-use',
        detail:
          'The refresh token expires from disuse. Note the trap: a workflow that already went quiet for another reason quietly becomes unrecoverable too, so a short outage turns into a manual re-auth.',
      },
      {
        condition: 'The tenant applies a Conditional Access sign-in frequency policy',
        certainty: 'conditional',
        window: 'whatever the policy says',
        windowSeconds: null,
        countsFrom: null,
        detail:
          'Since January 2021 refresh lifetimes are no longer configurable through token lifetime policies, but Conditional Access sign-in frequency still forces re-authentication on a schedule the client cannot see.',
        howToCheck:
          'Ask the tenant admin whether a sign-in frequency policy applies to this app. It is not visible from the automation side.',
      },
    ],
    sources: [
      'https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens',
      'https://learn.microsoft.com/en-us/entra/identity-platform/configurable-token-lifetimes',
    ],
    complaintLogRows: [14],
  },
  {
    id: 'meta-whatsapp',
    displayName: 'WhatsApp / Meta',
    match: {
      n8n: ['whatsapp', 'facebookgraph', 'facebookapp'],
      make: ['account:whatsapp', 'account:facebook', 'whatsapp', 'facebook'],
    },
    defaultAuthKind: 'api-key',
    // The decisive fact: this is a bearer token pasted by hand. Nothing refreshes it.
    autoRefreshable: false,
    rules: [
      {
        condition: 'The token was copied from the Meta app dashboard for testing',
        certainty: 'conditional',
        window: 'under 24 hours',
        windowSeconds: DAY,
        countsFrom: 'issued',
        detail:
          'Temporary access tokens expire in less than a day. Anyone who set this up while testing and never went back has a workflow that died the next morning.',
        howToCheck:
          'If the token came from the "Temporary access token" box on the app dashboard, it is already gone. Only a System User token survives.',
      },
      {
        condition: 'A System User token was generated with a 60-day expiry',
        certainty: 'conditional',
        window: '60 days',
        windowSeconds: 60 * DAY,
        countsFrom: 'issued',
        detail:
          'Meta lets you pick the expiry when generating a System User token. 60 days is the common choice and there is no warning before it lapses.',
        howToCheck:
          'Meta Business Settings -> Users -> System Users -> your user -> the token list shows the expiry you chose.',
      },
      {
        condition: 'A System User token was generated with no expiry',
        certainty: 'conditional',
        window: 'never',
        windowSeconds: null,
        countsFrom: null,
        detail: 'Permanent until someone revokes it manually.',
      },
    ],
    sources: [
      'https://developers.facebook.com/blog/post/2022/12/05/auth-tokens/',
      'https://community.n8n.io/t/whatsapp-token-expires/182022',
    ],
    complaintLogRows: [13],
  },
]);

/** Credential types that never expire on a clock — they get revoked instead. */
export const STATIC_KEY_HINTS = [
  'apikey',
  'api',
  'token',
  'httpheaderauth',
  'httpbasicauth',
  'httpqueryauth',
  'smtp',
  'postgres',
  'mysql',
  'redis',
  'mongodb',
];

/**
 * The provider a raw credential type belongs to ('googleSheetsOAuth2Api' on
 * n8n, 'account:google' on Make), or `null` when the table doesn't know it.
 * The same match the adapters use to fill `CredentialRef.providerId`.
 */
export function resolveProvider(rawType: string, platform: 'n8n' | 'make'): Provider | null {
  const needle = rawType.toLowerCase();
  for (const p of PROVIDERS) {
    for (const m of p.match[platform]) {
      if (needle.includes(m)) return p;
    }
  }
  return null;
}

/** Best-effort auth kind when no provider matches. */
export function guessAuthKind(rawType: string): AuthKind {
  const t = rawType.toLowerCase();
  if (t.includes('oauth2') || t.includes('oauth')) return 'oauth2';
  if (t.includes('basicauth')) return 'basic';
  if (t.includes('serviceaccount') || t === 'googleapi') return 'service-account';
  if (STATIC_KEY_HINTS.some((h) => t.includes(h))) return 'api-key';
  return 'unknown';
}
