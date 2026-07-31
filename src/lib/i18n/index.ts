import { en } from './en';
import { es } from './es';

export type Locale = 'es' | 'en';

const dictionaries = { es, en };

export function getDictionary(locale: Locale) {
  return dictionaries[locale];
}
