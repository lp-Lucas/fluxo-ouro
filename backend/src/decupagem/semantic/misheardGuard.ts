import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadModule } from "hunspell-asm";
import { levenshtein, normalizeWord } from "../../../../shared/text.js";

/**
 * GUARDA DE MISHEAR — PREDICADO LEXICAL (não é threshold de probability).
 *
 * O histograma refutou o threshold: mishears inequívocos ("axismo" prob 0.61) e
 * interjeições reais ("Tá" prob 0.02) ficam no MESMO lado do eixo. `probability` não
 * separa. O discriminante é LÉXICO:
 *
 *   éMishear(palavra, copy):
 *     sem copy                                   → false (a guarda não roda sem copy)
 *     palavra ∈ Hunspell pt_BR                   → false (é palavra real — morfologia real)
 *     ∃ w ∈ copy com levenshtein(palavra, w) ≤ 2 → true  (garble de uma palavra do roteiro)
 *     senão                                      → false
 *
 * DICIONÁRIO: Hunspell pt_BR REAL (.dic + .aff) via hunspell-asm (WASM). O .aff é a
 * morfologia — é ali que "sou" é reconhecido como forma de "ser". Não há lista manual:
 * a tentativa anterior (pt_BR_extra.txt) era o .aff reimplementado à mão e foi apagada.
 * nodehun não compila no Node 25; nspell/hunspell-spellchecker travam/quebram no .aff
 * do LibreOffice; hunspell-asm é o Hunspell C compilado em WASM, carrega em ~0.4s e faz
 * lookup sob demanda (sem pré-expansão). Sem rede em runtime; hashes de .dic/.aff pinados.
 *
 * Esta guarda é um FREIO REAL (não observação): a palavra que ela marca NUNCA é cortada
 * por nenhuma camada — entra como applied:false, reason ['mishear_provavel']. Por
 * construção não marca palavra real do Hunspell, então não poupa interjeição.
 *
 * `probability`/`avgLogprob` NÃO entram aqui.
 */

const DATA_DIR = process.env.DECUP_DATA_DIR ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../data");

/** Corretor com lookup síncrono (após o carregamento assíncrono do WASM). */
export interface Spellchecker {
  /** true se a palavra existe no Hunspell pt_BR (aplicando a morfologia do .aff). */
  check(word: string): boolean;
}

/** Verifica o sha256 de um arquivo de dados contra o `.sha256` pinado (sem rede em runtime). */
function verifyHash(file: string): void {
  const shaFile = file + ".sha256";
  if (!fs.existsSync(shaFile)) return;
  const want = fs.readFileSync(shaFile, "utf8").trim().split(/\s+/)[0];
  const got = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  if (want && got !== want) throw new Error(`dicionário ${path.basename(file)} com hash inesperado (esperado ${want.slice(0, 12)}…).`);
}

let checkerCache: Spellchecker | null = null;
let loadingPromise: Promise<Spellchecker> | null = null;

/**
 * Carrega o Hunspell pt_BR uma única vez (WASM, ~0.4s). Assíncrono; DEVE ser chamado no
 * startup (ou no início de um job) ANTES do primeiro `eMishear`/`runCopyLayer` — que são
 * síncronos e usam o singleton. Idempotente e concorrência-segura.
 */
export async function loadDicionario(): Promise<Spellchecker> {
  if (checkerCache) return checkerCache;
  if (loadingPromise) return loadingPromise;
  loadingPromise = (async () => {
    const aff = path.join(DATA_DIR, "pt_BR.aff");
    const dic = path.join(DATA_DIR, "pt_BR.dic");
    verifyHash(aff); verifyHash(dic);
    const factory = await loadModule();
    const affPath = factory.mountBuffer(fs.readFileSync(aff), "pt_BR.aff");
    const dicPath = factory.mountBuffer(fs.readFileSync(dic), "pt_BR.dic");
    const hs = factory.create(affPath, dicPath);
    checkerCache = {
      check(word: string): boolean {
        const w = word.trim();
        if (!w) return false;
        // Hunspell é sensível a caixa/acento; a fala vem com caixa arbitrária.
        // Aceita a forma original OU a minúscula (nomes próprios ⇒ só original).
        return hs.spell(w) || hs.spell(w.toLowerCase());
      },
    };
    return checkerCache;
  })();
  return loadingPromise;
}

/** Corretor já carregado; erro claro se `loadDicionario()` não foi chamado no startup. */
function getSpellchecker(): Spellchecker {
  if (!checkerCache) {
    throw new Error("Hunspell não carregado — chame `await loadDicionario()` no startup antes de eMishear/runCopyLayer.");
  }
  return checkerCache;
}

/**
 * Predicado da guarda. `copyTokens` normalizados (passe pré-computado para evitar
 * re-tokenizar por palavra). Sem copy → false. Reaproveita o Levenshtein de shared/.
 */
export function eMishear(palavra: string, copyTokens: string[], dict: Spellchecker = getSpellchecker()): boolean {
  if (copyTokens.length === 0) return false;       // sem copy, a guarda não roda
  const w = palavra.trim();
  if (!w) return false;
  if (dict.check(w)) return false;                 // palavra real (morfologia Hunspell)
  const n = normalizeWord(w);                      // garble → compara normalizado com o roteiro
  if (!n) return false;
  for (const t of copyTokens) {                    // garble de uma palavra do roteiro?
    if (Math.abs(t.length - n.length) <= 2 && levenshtein(n, t) <= 2) return true;
  }
  return false;
}

/** Tokens da copy normalizados (únicos) — entrada de `eMishear`. */
export function copyTokensNormalizados(copy: string): string[] {
  return [...new Set(copy.split(/\s+/).map(normalizeWord).filter(Boolean))];
}
