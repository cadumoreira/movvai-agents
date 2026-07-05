---
name: Radar de concorrência
description: Como monitorar concorrentes e reportar só o que mudou — use na rotina semanal de radar.
---

# Radar de concorrência

> ⚠️ **Exemplo/placeholder** — liste os concorrentes REAIS no manual da marca (ex.: um doc
> `concorrentes` com nome + URLs de pricing/blog/changelog) e ajuste o roteiro.

## Roteiro
1. Descubra a lista de concorrentes: `read_brand_doc` (doc de concorrentes, se houver) ou o brief.
2. Para cada um, leia com `fetch_url` as páginas que mudam: pricing, blog/changelog, home.
3. Compare com o que você já registrou (licoes.md e relatórios anteriores no Notion).
4. Reporte **só o que mudou**: preço, feature nova, campanha nova, mudança de posicionamento.
   Sem mudança = diga "sem mudanças relevantes" (não infle o relatório).
5. Mudança estratégica relevante → `record_lesson` (uma frase acionável) e sugira reação à Malu.

## Regras
- Nunca invente: se a página não abriu, diga que não abriu.
- Cite a URL de cada achado.
- Tom: análise de colega, não espionagem dramática.
