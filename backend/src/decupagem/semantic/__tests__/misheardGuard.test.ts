import { test, before } from "node:test";
import assert from "node:assert/strict";
import { eMishear, copyTokensNormalizados, loadDicionario } from "../misheardGuard.js";

// Hunspell (WASM) carrega assíncrono uma vez; eMishear é síncrono e usa o singleton.
before(async () => { await loadDicionario(); });

// Copy REAL do projeto 517889c9 (de onde vieram as 13 palavras do decupagem_mishear.jsonl).
// Contém "achismo" (a ≤2 de "axismo") e "Williams" — a base dos casos do histograma.
const COPY = "Toda empresa de tecnologia começa com um problema real. A AIVO começou com dois. Ibrahim é empresário com operações em advocacia e saúde. Ele vivia o problema que a AIVO resolve: processos manuais, time sem visibilidade, decisões no achismo. Sempre quis ter uma empresa de tecnologia. Quando encontrou o parceiro certo, foi de cabeça. Williams é desenvolvedor há mais de uma década, com projetos de automação e inteligência artificial. Ele construiu cada módulo da plataforma do zero. Não como exercício técnico. Como resposta às dores reais que via nos clientes. A AIVO não foi criada em uma sala de reunião. Foi criada nas madrugadas, resolvendo problemas reais.";
const tokens = copyTokensNormalizados(COPY);

test("Hunspell reconhece formas irregulares/contrações via morfologia do .aff", async () => {
  const d = await loadDicionario();
  // 'sou' (forma irregular de 'ser') vem do .aff — era o que o suplemento manual mascarava.
  for (const w of ["sou", "pros", "somos", "são", "fui", "isso", "forte", "empresário"]) {
    assert.ok(d.check(w), `Hunspell deveria reconhecer "${w}"`);
  }
  // não-palavras não podem ser reconhecidas
  for (const w of ["axismo", "retornação", "qwerty"]) {
    assert.ok(!d.check(w), `Hunspell NÃO deveria reconhecer "${w}"`);
  }
});

test("axismo → mishear (freia): garble a ≤2 de 'achismo' no roteiro", () => {
  assert.equal(eMishear("axismo", tokens), true);
});

test("Tá, Ai, Isso, forte, sou, Pros → NÃO mishear (cortáveis)", () => {
  for (const w of ["Tá", "Ai", "Isso", "forte", "sou", "Pros"]) {
    assert.equal(eMishear(w, tokens), false, `"${w}" foi marcado mishear indevidamente`);
  }
});

test("retornação → registra o resultado (sem regra especial; a IA pega se não freiar)", () => {
  const r = eMishear("retornação", tokens);
  console.log(`  [registro] retornação → mishear=${r} (esperado tudo bem em qualquer valor)`);
  assert.ok(r === true || r === false);
});

test("sem copy → guarda nunca marca (retorna false)", () => {
  assert.equal(eMishear("axismo", []), false);
  assert.equal(eMishear("qualquercoisa", []), false);
});

test("palavra real fora da copy não é mishear mesmo perto de token do roteiro", () => {
  // 'forte' é real (dicionário) → nunca mishear, ainda que pareça com algo do roteiro
  assert.equal(eMishear("forte", tokens), false);
});
