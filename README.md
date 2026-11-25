# `paltex` — Ferramenta de Texturas em Pixel Art Indexada para Terminal e LLMs

`paltex` ([`paltex.mjs`](paltex.mjs)) é uma ferramenta CLI em Node.js (`>= 16`, zero dependências externas) para criar texturas ilustradas e materiais tileáveis no estilo da era **Quake 1 / Doom 2 / Chasm**.

Todo pixel do canvas é um **índice de paleta 8-bit (`0..255`)**: nenhuma operação gera cores fora da paleta. Além do canal de cor, a ferramenta possui um **canal de altura paralelo (`height`)**, iluminação direcional (`light`), camadas (`layer`), simetria (`sym`), sprites por degrau de rampa, hachuras (`hatch`), pincel de cerdas (`bristle`) e diagnóstico (`--trace`, `diff`, `lint`).

---

## Sumário

- [1. Execução no Terminal](#1-execução-no-terminal)
- [2. Conceitos Fundamentais](#2-conceitos-fundamentais)
- [3. Paletas, Rampas e Fullbright](#3-paletas-rampas-e-fullbright)
- [4. Desenho Vetorial, Pincéis e Escopo (`with brush`)](#4-desenho-vetorial-pincéis-e-escopo-with-brush)
- [5. Sprites por Degrau, Captura (`grab`) e Camada de Luz (`stamp shade`)](#5-sprites-por-degrau-captura-grab-e-camada-de-luz-stamp-shade)
- [6. Volume Real (`height`), Iluminação (`light`) e Hachura (`hatch`)](#6-volume-real-height-iluminação-light-e-hachura-hatch)
- [7. Atalhos de Fluxo: Simetria, Camadas, Undo e Checkpoints](#7-atalhos-de-fluxo-simetria-camadas-undo-e-checkpoints)
- [8. Inspeção, Trace Visual e Lint](#8-inspeção-trace-visual-e-lint)
- [9. Textura Procedural e Filtros 2D](#9-textura-procedural-e-filtros-2d)
- [10. Exemplo Completo (Parede com Crânio Estilo Quake)](#10-exemplo-completo-parede-com-crânio-estilo-quake)

---

## 1. Execução no Terminal

```bash
# Ajuda geral ou de um comando específico
node paltex.mjs help
node paltex.mjs help light

# Executar um arquivo de script .ptx
node paltex.mjs textura.ptx

# Executar via stdin (ideal para LLMs / pipelines)
node paltex.mjs - <<'EOF'
new 64 64 stone:4
ellipse 32 32 16 16 bone:8 fill
save out.png scale=4
EOF

# Executar salvando recortes ampliados de cada comando que alterar pixels
node paltex.mjs textura.ptx --trace ./trace_dir --trace-scale 4 --trace-pad 4

# Rodar a suíte de testes
npm test
```

### Opções de Linha de Comando para `--trace`

| Flag | Padrão | Descrição |
| --- | --- | --- |
| `--trace <dir>` | desativado | Salva um PNG recortado e ampliado em `<dir>` após cada comando que modificar pixels. |
| `--trace-scale <N>` | `4` | Fator de ampliação nearest-neighbor (`1..32`). |
| `--trace-pad <N>` | `4` | Margem em pixels ao redor da área modificada (`0..64`). |
| `--trace-all` | desativado | Salva o canvas inteiro em vez do recorte mínimo ao redor do que mudou. |

> [!TIP]
> Você também pode ligar e desligar o trace **no meio de um script** com `trace on <dir> [scale=4] [pad=4] [all]` e `trace off` para inspecionar apenas o trecho que está ajustando.

---

## 2. Conceitos Fundamentais

### Canvas e Tiling (`new`, `wrap`)
- `new <w> <h> [color]`: cria o canvas (`1..4096`) preenchido com `color` (padrão índice `0`) e zera o mapa de altura. Se nenhuma paleta tiver sido carregada, carrega a paleta `builtin` automaticamente.
- `wrap on | off`: padrão `on`. Qualquer traço, filtro, `height` ou `zoom` que cruze a borda continua do lado oposto, mantendo a textura sem costuras (*seamless*).

### Formato de Cores
Qualquer argumento `<color>` aceita:
- **Índice direto**: `0..255` (conforme tamanho da paleta)
- **Rampa e degrau**: `ramp:step`, onde `0` é o mais escuro e `-1` o mais claro (ex.: `stone:7`, `bone:-1`). Omitir `:step` escolhe o meio da rampa (`stone`).
- **Chave (`@key`)**: caractere definido antes com `key a stone:5` -> `@a`
- **Hex (`#hex`)**: `#rgb`, `#rrggbb` ou `#aarrggbb` — faz snap para a cor **não-fullbright** mais próxima na paleta.
- **Relativo (`+n` / `-n`)**: desloca a cor que já está no pixel `n` degraus na mesma rampa (ex.: `+2` clareia 2 degraus, `-3` escurece 3). Cores fora de rampa usam fallback RGB (`1.18^n`).

### Escopo (`mask=`, `shape=` e `region=`)
Praticamente todo comando de desenho, altura, iluminação ou filtro aceita:
- `mask=<lista>`: restringe o comando às cores especificadas (ex.: `mask=stone,rust:3,@a`). O nome de uma rampa seleciona **todos os seus degraus**. Prefixo `!` inverte a máscara (ex.: `mask=!slate:2`).
- `shape=<expr>`: restringe o comando à máscara booleana 2D criada com `shape`, aceitando expressões booleanas inline com `!`, `&`, `|` e parênteses (ex.: `shape=skull`, `shape=!skull`, `shape=skull&!eyes`, `shape=(cranium|horns)&!socket`).
- `region=x,y,w,h` ou `region=anchor:<nome>[,w[,h]]`: restringe a uma janela retangular ou caixa centrada em uma âncora (com suporte a wrap).
- Todos são avaliados sobre um **snapshot tirado antes do comando começar**, então `noise`, `light` ou `stroke +2` nunca interferem nas próprias leituras durante o mesmo passo.

### Comentários em Scripts
- Linhas começando com `#` são comentários.
- Comentários inline (` # ...`) são removidos fora de aspas e preservam `#hex` e `#=cor` (e nunca são removidos no comando `key`, onde `#` pode ser a tecla).

---

## 3. Paletas, Rampas e Fullbright

| Comando | Descrição |
| --- | --- |
| `palette` | Lista todas as cores (`*` indica fullbright) e as rampas atuais. |
| `palette builtin` | Paleta padrão `grime`: 16 rampas × 16 degraus (`grey`, `dirt`, `stone`, `moss`, `rust`, `brick`, `flesh`, `blood`, `slime`, `water`, `steel`, `brass`, `bone`, `lava`, `purple`, `teal`). |
| `palette quake [arquivo.lmp]` | Sem arquivo, gera uma paleta original de 256 cores no layout do Quake 1 (14 rampas de material + alias `bone` + 4 rampas fullbright separadas `fb_lava`, `fb_fire`, `fb_plasma`, `fb_runic`, além dos aliases `fb_warm`/`fb_cool`, marcando `224..255` como fullbright). Com caminho `.lmp`, carrega a paleta real e aplica as rampas Quake + fullbrights. |
| `palette fullbright <idx\|a..b...\|clear>` | Marca índices como **fullbright** (ou limpa). |
| `palette file <caminho>` | Carrega `.png`, `.gpl`, `.pal` (JASC), lista hex ou RGB bruto (`palette.lmp`, `PLAYPAL`). |
| `palette set <#hex> ...` | Define paleta customizada. |
| `ramp` / `ramp auto [n]` / `ramp quake` | Lista rampas, cria `r0, r1...` agrupadas de `n` em `n` ordenadas por luminância, ou aplica o mapeamento de rampas Quake. |
| `ramp <nome> <idx\|a..b\|#hex> ... [alias\|primary]` | Define uma rampa manual (do escuro ao claro). |

### Como funciona `fullbright`
Índices marcados como fullbright (como `224..254` em `palette quake`, ideais para olhos brilhantes, lava e runas):
1. **Não são escurecidos nem clareados** por `light`, `bevel`, `cavity`, `grad shade/tint`, `noise shade/tint`, `hatch` relativo, `stamp ... shade` ou `layer merge mode=shade`.
2. **São excluídos** da busca automática de [`nearest()`](paltex.mjs#L210-L235) (`#hex` e `import` sem lista explícita de rampas), evitando que áreas comuns acabem usando cores brilhantes por acidente.

---

## 4. Desenho Vetorial, Pincéis e Escopo (`with brush`)

### Primitivas
- `pixel <x> <y> <color>`
- `line <x0> <y0> <x1> <y1> <color>` — 1px Bresenham por padrão; usa pincel se um pincel estiver ativo ou opções de pincel forem passadas.
- `rect <x> <y> <w> <h> <color> [fill] [center]`
- `ellipse <cx> <cy> <rx> <ry> <color> [fill]`
- `poly <color> <x,y> <x,y> <x,y> ... [fill]`
- `flood <x> <y> <color> [diag]`
- `stroke <color> <x,y> ... [closed] [opts]` — polilinha com pincel.
- `curve <color> <x,y> ... [closed] [opts]` — 3 pts (Bézier quadrática), 4 pts (cúbica), 5+ pts (spline Catmull-Rom).
- `spline <color> <x,y> ... [closed] [opts]` — Catmull-Rom passando por todos os pontos (`2+`).

### Pincéis (`brush` e `with brush ... end`)
Formas disponíveis: `circle`, `square`, `chisel`, `diamond`, `soft`, `spray`, `bristle`, `chalk`, `mottle`, `sprite <nome> [alpha]`.

Opções de forma e trajetória:
- `size=1..128`, `angle=DEG`, `aspect=10..400`
- `spacing=1..128` ou percentual relativo ao tamanho (`spacing=25%`)
- `taper=end | start,end | start,mid,end` (`0..200`%)
- `jitter=0..64`, `scatter=0..64`, `density=1..100` (para `spray`)
- `dither=bayer2|bayer4|bayer8|noise[:seed]|fs|none`
- `rot=fixed|follow|random`, `seed=N`
- **Pincel de cerdas (`bristle`)**: `n=1..32` (ou `bristles=`), `skip=0..95` (falhas longitudinais), `shade=n | lo,hi` (`-16..16`).
- **Tips procedurais (`chalk`, `mottle`) e `sprite ... alpha`**:
  - `chalk` e `mottle` modulam a cobertura por ruído contínuo em coordenadas do canvas (`tex_scale=1..64`, padrão `8`), evitando carimbos repetidos em baixa resolução.
  - `brush sprite <nome> alpha` (ou flag `alpha`) usa os degraus (`0-9a-z`) ou luminância do sprite como máscara de cobertura `0..1`.

**Mistura, acumulação e dinâmica pictórica:**
- `flow=1..100` e `opacity=1..100`: acumulam cobertura ao longo dos dabs pela curva `A = min(opacity, 1 - (1 - A)(1 - flow * w))`.
- `blend=auto | mix | replace | tint | rgb`:
  - `auto` (padrão): usa `mix` quando a cobertura é parcial (`< 100%`) e `replace` quando sólida.
  - `mix`: interpola degraus dentro da mesma rampa (ex.: `bone:4` + `bone:12` a 50% -> `bone:8` com dither) e usa cobertura ditherada entre rampas diferentes.
  - `tint`: aplica o matiz da rampa preservando a luminosidade existente.
  - `rgb`: interpola em RGB e faz snap na paleta (use `ramps=a,b` para restringir as rampas permitidas).
- **Dinâmica por carimbo**: `size_jitter=0..100` (%), `angle_jitter=0..180` (graus), `shade_jitter=0..16` (degraus) e `flow_jitter=0..100` (%).

#### Escopo seguro de pincel (`with brush ... end`)
Para evitar que um pincel grosso configurado antes vaze para `line` ou traços seguintes, envolva o trecho em um bloco `with brush`:

```text
with brush bristle n=5 size=7 skip=25 shade=-1,+1 seed=42
  stroke moss:5 12,4 22,28 mask=!flesh
end
# Aqui o pincel volta automaticamente ao estado anterior (ex.: line volta a ser 1px)
line 0 60 127 60 slate:1
```

Blocos `with brush` podem ser aninhados. Além disso, passar `brush=<forma>` diretamente em um único comando (ex.: `stroke bone:8 0,0 20,20 brush=chisel size=4`) parte de uma configuração limpa de fábrica, sem herdar `taper`/`scatter` antigos.

> [!NOTE]
> Se um comando de pincel usar `size >= 4` maior que a `region=` ou a caixa da `mask=`, o motor emite um `warning` automático.

---

## 5. Sprites por Degrau, Captura (`grab`) e Camada de Luz (`stamp shade`)

### Definição tradicional por chaves (`key`)
```text
key # stone:0
key b bone:8
sprite prego
.##.
#bb#
.##.
end
```
*(`.` e espaço `' '` são transparentes).*

### Grade em degraus de rampa (`ramp=` / `outline=`)
Agora você pode desenhar sombreamento complexo direto na grade usando `0-9` e `a-z` (`0..35`) como degraus da rampa e `#` como contorno, além de overrides pontuais de 1 caractere:

```text
sprite skull ramp=bone outline=stone:0 *=blood:12
..####..
.#9ba9#.
.#*88*#.
..5445..
end
```

### Sprites de luz relativa (`shade`) e `stamp ... shade`
Qualquer sprite com passos (especialmente criado com `shade` ou `ramp=`) pode ser carimbado como **camada relativa de iluminação** sobre o que já existe no canvas:

```text
sprite brilho shade
.48c.
48fc8
.48c.
end

# Aplica delta = degrau - mid (padrão mid=8: '8'=0, '4'=-4, 'c'=+4, 'f'=+7)
stamp brilho 16 16 shade
```

### Edição, inspeção e captura do canvas
- `sprite <nome> row <y> "<linha>"`: edita uma linha (`0-based`) sem reescrever o sprite inteiro.
- `sprite show <nome> [view=char|idx|step]`: imprime o sprite com réguas e legenda.
- `grab <nome> <x> <y> <w> <h> [mask=]`: recorta uma região do canvas (com wrap se ligado); pixels fora da `mask=` ficam transparentes (`-1`).
- `stamp <sprite> <x> <y> [center] [scale=N|PCT%|W,H] [shade | shade=n] [mid=N] [rot=0|90|180|270] [flipx] [flipy] [repeat=nx,ny step=sx,sy]` — `center` alinha o centro do sprite a `x,y`; `scale=` redimensiona por nearest-neighbor mantendo a paleta.
- `scatter <sprite[,sprite...]> <n> [seed=N] [min=D] [inside] [rot=any|0|90..] [flip] [shade=n|lo,hi]`

---

## 6. Volume Real (`height`), Iluminação (`light`) e Hachura (`hatch`)

O canal de altura (`S.hmap`) armazena relevo contínuo paralelo ao canvas de índices e acompanha automaticamente `resize`, `shift` e `flip`.

### Comandos `height`

| Subcomando | Descrição |
| --- | --- |
| `height inflate [mask=] [region=] [radius=N] [amount=6] [profile=round\|dome\|smooth\|linear] [mode=add\|max\|set\|smin] [k=3]` | Calcula a Transformada de Distância Euclidiana até a borda da máscara e cria volume arredondado (`mode=smin k=3` faz união orgânica suave sem vincos). |
| `height bevel [mask=] [region=] [depth=4] [amount=6] [profile=linear\|round\|dome\|smooth] [mode=add\|max\|set\|smin]` | Sobe por `depth` pixels a partir da borda e mantém um platô plano no topo (ideal para chapas e molduras). |
| `height stroke\|curve\|spline <val> <x,y>... [size=3] [taper=] [soft] [ridge] [closed] [mode=add\|max\|set\|smin]` | Esculpe sulcos negativos (`-4`) ou cristas positivas (`+5`, `ridge`) diretamente no canal de altura (com suporte a `sym`). |
| `height ribs <val> <x,y> <x,y> ... [count=8] [depth=2] [size=6] [taper=100,35] [sharp=50] [color=<c>] [hi=<c>] [mode=...]` | Gera gomos/anéis periódicos esculpidos ao longo de uma curva (ideal para chifres, cabos, correntes e vértebras) em 1 linha. |
| `height crack <x0,y0> <x1,y1> [depth=3] [width=1] [branch=2] [wobble=2.5] [color=<c>] [lip=<+n\|c>] [seed=N]` | Cria fissura ramificada gravando vale no `hmap`, opcionalmente escurecendo a fenda e iluminando a borda (`lip=`). |
- `height compose <srcLayer> [dstLayer] [mode=smin|max|add|over|set] [k=3]` | Compõe o relevo da camada fonte na camada destino e zera a fonte para evitar aplicação duplicada. |
| `height rect\|ellipse\|poly` / `height grad <x0> <y0> <x1> <y1> [from=0 to=4] [mode=linear\|radial] [radial]` | Desenha formas geométricas ou planos inclinados diretamente no relevo ativo. |
| `height add <val> [mask=] [region=]` | Soma `val` (pode ser negativo, ex.: `height add -4 mask=socket`). |
| `height set <val> [mask=] [region=]` | Define altura fixa no escopo. |
| `height clear [val=0]` | Reseta o canal de altura inteiro. |
| `height scale <pct>` | Multiplica as alturas do escopo por `pct/100`. |
| `height noise [type=...] [scale=16] [octaves=2] [warp=0] [amount=4] [from=] [to=] [contrast=] [bias=] [seed=] [mode=add\|set]` | Adiciona ou define ruído tileável no mapa de altura. |
| `height blur [radius=1..8] [passes=1..8] [bleed]` | Suaviza o relevo (por padrão respeita as bordas da máscara; `bleed` mistura através da borda). |
| `height from=luma\|step [amount=8] [mode=set\|add]` | Extrai altura a partir da luminância ou do degrau da rampa atual no canvas. |

Para visualizar o mapa de altura no terminal: `dump view=height` ou `zoom x y w h view=height` (mostra de `0` = mínimo a `z` = máximo).

### Iluminação pelo relevo (`light`, `albedo`, `relight`)
```text
albedo save
light begin
  light height dir=nw elev=40 range=-4..+4 shadow_ramp=purple:45% hi_ramp=gold:30% spec=2 ao=3 shadow=8 shape=skull
  light height dir=se elev=25 range=0..+2 rim=se rim_ramp=teal:60% rim_strength=2 shape=skull
light end
```
- `shadow_ramp=<ramp[:pct%]>` / `hi_ramp=<ramp[:pct%]>` (`light_ramp=`): deslocamento automático de matiz (*hue-shifting*) em sombras e realces dentro da paleta (também aceito em `cavity`, `bevel` e `grad shade`).
- `rim=<dir>` / `rim_ramp=<ramp[:pct%]>` / `rim_strength=`: luz de recorte (*rim light*) em arestas rasantes.
- **`light begin [keep] ... light end` + `albedo [save|restore|clear]` + `relight`**: acumula múltiplas fontes de luz em ponto flutuante sobre o albedo sem dupla quantização (`light begin` tira snapshot novo por padrão, use `keep` para reutilizar o último `albedo save`), preservando camadas de acabamento (`paint_over`) acima da camada iluminada ao rodar `relight`.
- `dir=n|ne|e|se|s|sw|w|nw` e `elev=1..89` (graus acima do horizonte).
- `range=lo..hi` (ou `from=` / `to=`): deslocamento em degraus relativo ao plano horizontal (`sin(elev)` fica em `0` para não alterar superfícies planas), ou mapeamento absoluto quando `ramp=<nome>` é informado.
- `strength=100`: escala da inclinação das normais Sobel 3×3.
- `spec=` / `gloss=`: brilho especular Blinn-Phong em degraus extras.
- `ao=` / `ao_radius=`: oclusão de ambiente calculada diretamente da concavidade em `S.hmap`.
- `shadow=N`: raymarch curto de até `N` pixels na direção da luz para sombras projetadas pelo relevo.

### Hachura (`hatch`)
```text
hatch mask=bone follow=contour in=shadow angle=-25 spacing=4 shade=-1 jitter=1
```
- Aceita uma `<color>` posicional ou `shade=<n>` (padrão `-1`).
- `in=all | shadow | mid | light`: concentra as hachuras só nas sombras (`<= 0.52`), meios-tons (`0.25..0.72`) ou luzes (`>= 0.55`), mantendo realces limpos.
- `follow=none | contour | slope`:
  - `none`: linhas paralelas no ângulo `angle=` (padrão `-45`).
  - `contour`: streamlines espaçadas por `spacing=` seguindo as curvas de nível do mapa de altura (ou da distância da borda da máscara se `S.hmap` estiver zerado), rotacionadas por `angle=` (padrão `0`).
  - `slope`: segue a direção do gradiente de descida/subida.
- `cross`: adiciona uma segunda passada perpendicular (`angle + 90`).

---

## 7. Atalhos de Fluxo: Simetria, Camadas, Undo e Checkpoints

### Âncoras nomeadas (`anchor`)
- `anchor <nome> <x> <y> [w [h]]` (ou `anchor list`, `anchor clear`): cria referências reutilizáveis com tamanho opcional centrado (ex.: `anchor olho 53 51 16 14` -> `olho+4,olho-2`, `olho.x+4`, `olho.w` ou `region=anchor:olho`). Âncoras implícitas sempre disponíveis: `cx`, `cy`, `w`, `h`.

### Formas compostas CSG 2D (`shape`)
Permite construir, combinar e inspecionar silhuetas booleanas em ASCII antes de aplicar altura, luz ou pincéis:
- `shape [nome] new|clear|select|list|drop|copy`: gerencia máscaras 1-bit nomeadas (ex.: `shape skull new`).
- `shape [nome] add|sub|and|xor <primitiva>`: une, subtrai, intersecciona ou aplica XOR com `ellipse`, `rect ... [center]`, `poly`, `stroke|curve|spline [size=N]`, `mask <cores>` ou outro `shape <nome>` (respeita `sym`).
- `shape [nome] invert|mirror|grow|erode|rough`: inverte, espelha, expande/encolhe por EDT (`grow`/`erode`) ou quebra bordas organicamente (`rough`) direto na máscara.
- `shape [nome] show [all] [region=...]`: imprime a silhueta (`#`/`.`) em ASCII com réguas (recorte automático na bounding box, custo zero de imagem).
- `shape [nome] fill <cor>` / `shape [nome] outline <cor> [side=outer|inner] [diag]`: aplica a forma ao canvas — e você pode passar `shape=<nome>` (ou `shape=!<nome>`) diretamente em `height`, `light`, `noise`, `hatch`, etc.

### Simetria (`sym`)
```text
sym x axis=63.5 [jitter=1] [seed=0]
ellipse 48 54 6 5 slate:1 fill
sym off
```
- Modos: `off`, `x`, `y`, `xy`.
- `axis=N`, `ax,ay` ou âncora (ex.: `axis=skull` ou `axis=cx-0.5`; omitido usa o centro `(w-1)/2`).
- `jitter=N` aplica pequena assimetria suave por traço/comando (sem fragmentar linhas).
- Espelha comandos geométricos (`pixel`, `line`, `rect`, `ellipse`, `poly`, `flood`, `stroke`, `curve`, `spline`, `stamp`, `shape`) sem corromper filtros direcionais como `light`, `bevel` ou `noise`.
- Também pode ser passado inline em um único comando (`sym=x|y|xy|off [axis=...]`) sem alterar o estado global seguinte.

### Camadas (`layer`)
- `layer new [nome] [shade] [hmode=add|max|over|smin] [k=2.5]`: cria camada transparente acima da atual com seu próprio canal de altura opcional (`hmode=smin` une relevos organicamente sem vinco duro).
- `layer hmode <add|max|over|smin> [k=2.5]`: ajusta ao vivo o modo de composição de altura da camada ativa.
- `layer merge [mode=replace|shade]`: mescla cor e relevo da camada ativa na camada inferior e a remove. Em `mode=shade`, converte a cor/degrau da camada superior (relativo ao meio da rampa) em deslocamento de degraus sobre a camada de baixo.
- `layer list`, `layer select <nome|idx>`, `layer vis on|off`, `layer clear`, `layer drop`.

### Histórico (`checkpoint`, `restore`, `undo`, `diff`)
- `checkpoint <nome>` / `restore <nome>`: salva ou restaura um snapshot completo (canvas, `hmap` e camadas).
- `undo [n]`: desfaz os últimos `n` comandos mutantes (pilha de até 50 passos).
- `diff [checkpoint] [view=char|step|idx]`: mostra em ASCII **somente o recorte modificado** pelo último comando (ou desde um checkpoint), exibindo `.` nos pixels intactos.

---

## 8. Inspeção, Trace Visual, Estado e Lint

- `dump [view=char|idx|step|height|luma|halfblock] [scale=N] [region=x,y,w,h|anchor:nome]` e `zoom <x> <y> <w> <h> [view=...] [scale=N]` — inspecione silhuetas em ASCII, mapa de luminância (`view=luma`), minimapa ANSI truecolor (`halfblock`) ou relevo (`height`), opcionalmente reduzido com `scale=N`.
- `bounds [bg=<cor>] [shape=…] [mask=…] [region=…]`: retorna a caixa delimitadora exata e a cobertura dos pixels não-fundo.
- `probe <x> <y>`: inspeciona um pixel único (índice, hex, RGB, luminância, `rampa:passo`, altura `hmap`, camada ativa e `shapes`).
- `state save <arquivo.ptxs>` / `state load <arquivo.ptxs>`: serializa ou restaura todo o estado binário (canvas, `hmap`, camadas, paleta, rampas, `shapes`, âncoras e sprites) entre execuções.
- `include <arquivo.ptx>`: executa comandos de outro script `.ptx` no estado atual (com detecção de ciclo).
- `sheet <arquivo.png> [scale=3] [pad=8]` (ou flag CLI `--sheet <arquivo.png>`): gera uma folha de contato RGB PNG com **1×**, **N× com réguas**, **2×2 tiled** e **mapa de altura**.
- `seam`: mede o salto médio de cor nas bordas `x` e `y` comparado ao interior do tile.
- `info`: exibe dimensões, `wrap`, `sym`, quantidade de camadas, paleta, chaves, sprites e pincel ativo.
- `lint [mask=] [region=] [jump=3] [histogram] [json] [overlay=<arquivo.png>]` (ou flag CLI `--json`):
  - `[noise]`: pixels isolados (excluindo dithers regulares e linhas finas)
  - `[dither]`: blocos grandes (`>= 36 px`) de padrão 2×2 repetitivo
  - `[banding]`: saltos intra-rampa `> jump` entre vizinhos adjacentes
  - `[ramp]`: pequenas manchas (`<= 3 px`) de uma rampa perdidas dentro de outra rampa dominante
  - `[unramped]`: pixels não-fullbright sem rampa associada
  - `[histogram]`, `[readability]` e `[repeat]`: distribuição tonal em 5 zonas, legibilidade em escala 1/4 e detecção de repetição periódica por autocorrelação
  - `overlay=<arquivo.png>`: salva PNG RGB anotado destacando os problemas encontrados
  - Executa `seam` automaticamente no canvas inteiro.
- `save <arquivo.png> [scale=N] [tile=N]`: exporta PNG indexado 8-bit com paleta embutida.

### Linguagem de Script (`let`, `{expr}`, `for`/`repeat`, `macro`, `stamp_along`, `--strict`)
- `let <nome> = <expr>` (aceita múltiplos comandos separados por `;`, ex.: `let cx=63.5; let brow_y=54; let tooth_y=brow_y+27`).
- **Expressões inline e `{expr}`**: coordenadas e parâmetros numéricos aceitam expressões aritméticas, trigonométricas (`sin`, `cos`, `atan2`, `sqrt`, `abs`, `min`, `max`, `floor`, `round`, `pi`) e propriedades de âncoras (`eye.y+eye.h/2`, `cx-14`), tanto diretamente quanto dentro de `{...}`.
- **Loops**: `for <var> <ini>..<fim> [step=S]: <comando>` (1 linha) ou bloco `for ... end`, além de `repeat <N> [var]` (`... end` ou `: <comando>`).
- **Macros**: `macro <nome> [arg1 arg2 ...]` ... `end` — chamadas diretamente por `<nome> <v1> <v2> ...`, com escopo local de parâmetros (números ou strings/cores).
- **`stamp_along` / `scatter_along`**: `<sprite|sp1,sp2> curve|spline|line <p1 p2 ...> [count=N] [spacing=N] [rot=follow|random|DEG] [jitter=N] [seed=N]` — distribui sprites ao longo de curvas/linhas, alinhando à tangente local com `rot=follow` (e rotação em ângulo arbitrário no `stamp`).
- **Modo estrito (`--strict` ou `strict on|off`)**: transforma qualquer `warning` (opção desconhecida, comando que alterou 0 pixels, `height` sem alterações) em erro fatal com código de saída `!= 0`.

---

## 9. Textura Procedural e Filtros 2D

- `masonry <ramp> [style=running|grid|ashlar] [w=32 h=16 | cols=N rows=N] [mortar=2] [mortar_color=<c>] [bevel=3] [height=5] [vary=2] [tilt=1] [rough=1.8] [chip=35] [rivets] [seed=N]` — gera alvenaria/blocos sem costuras escrevendo cor + relevo orgânico chanfrado por bloco no canal de altura.
- `plates <ramp> [w=32 h=32 | cols=N rows=N] [mortar=1] [bevel=2] [height=4] [vary=1] [tilt=1] [rivets] [seed=N]` — atalho para chapas metálicas rebitadas.
- `glow` / `emit` `[mask=<emissores>] [radius=6] [ramp=<nome>] [strength=75] [mode=mix|rgb|tint|shade] [dither=bayer4] [normal] [ramps=a,b]` — projeta luz local ao redor de pixels fullbright (ou da `mask=`), opcionalmente modulada pelas normais de `height` (`normal`).
- `grad <ramp|shade> <x0> <y0> <x1> <y1> [from=a to=b] [dither=...] [mode=linear|radial] [radial] [tint [prob=P]]` *(use `mode=radial` ou `radial` para poder combinar livremente com `shape=<expr>`)*
- `noise <ramp|shade> [type=value|turbulence|ridged|voronoi|cracks|cells] [scale=N|scalex=N scaley=N] [octaves=1..6] [warp=N] [from=a to=b] [contrast=%] [bias=%] [seed=N] [tint [prob=P]]`
- `dfill <color> <pct> [bayer=2|4|8 | noise=SEED]` *(emite aviso se usar `bayer=2` em `>= 256 px`)*
- `rough mask=<shape> [amount=1..8] [prob=P] [side=both|in|out] [clump=1..32] [seed=N]`
- `chip mask=<shape> [prob=P] [size=1..3] [face=n] [seed=N]`
- `smudge [radius=1..8] [strength=%] [dir=x|y|d1|d2|n|s|e|w...] [len=1..32] [passes=1..8] [protect=...] [blend=ramp|nearest ramps=a,b] [round=noise|nearest]`
- `cavity [mask=] [against=] [radius=1..6] [lo=1..16] [min=%] [shadow_ramp=<r[:pct%]>] [dither=...] [seed=N]`
- `bevel [mask=] [region=] [light=...] [depth=N] [hi=N] [lo=N] [shadow_ramp=] [hi_ramp=] [soft]`
- `drip [color|ramp|shade] [from=cavity|mask|all] [dir=s|n|e|w] [len=6..16] [width=1..3] [density=45] [shade=-3] [tint] [dither=...] [protect=...] [seed=N]` — escorridos orgânicos por gravidade a partir de rebites, juntas ou cavidades.
- `wash [color|ramp|shade] [radius=3] [strength=65] [dither=...] [mask=] [shape=]` — acumula sujeira, azinhavre ou sombra nas reentrâncias côncavas do `hmap`.
- `drybrush` / `edgewear [color|ramp|+n] [thresh=0.45] [strength=75] [breakup=45] [light=dir] [hi=+2] [dither=...] [seed=N]` — realce quebrado automático nas cristas convexas do `hmap`.
- `outline <color> mask=<shape> [side=outer|inner] [diag]`
- `pixelate <n> [mask=] [region=]`
- `import <file.png> <x> <y> [w=N h=N] [dither=fs|bayerN|noise] [spread=N] [ramps=a,b]`
- `resize <w> <h>`, `shift <dx> <dy>`, `flip x|y`

---

## 10. Exemplo Completo (Parede com Crânio Estilo Quake)

```text
palette quake
new 128 128 slate:4

# Blocos de pedra com argamassa irregular e relevo
rect 0 0 128 128 slate:2
line 0 64 127 64 slate:2
line 64 0 64 63 slate:2
rough mask=slate:2 amount=2 prob=65 clump=3 seed=11
noise slate type=ridged scale=24 octaves=3 from=3 to=7 mask=!slate:2 seed=5
height from=step amount=3 mask=!slate:2
height set -2 mask=slate:2
height blur radius=1 passes=2

# Crânio central simétrico
sym x axis=63.5
ellipse 64 58 28 30 flesh:6 fill
rect 48 78 32 18 flesh:6 fill
sym off
rough mask=flesh amount=2 prob=55 clump=3 side=both seed=21
outline slate:1 mask=flesh side=outer

# Órbitas, nariz e dentes
sym x axis=63.5
ellipse 51 54 7 6 slate:1 fill
poly slate:1 63,62 58,72 63,72 fill
line 52 80 52 94 slate:1
line 58 80 58 94 slate:1
sym off

# Volume 3D + luz direcional + hachura de contorno
height inflate mask=flesh amount=10 profile=round mode=set
height add -5 mask=slate:1 region=32,30,64,66
height noise type=value scale=10 amount=1.5 mode=add mask=flesh seed=9
height blur radius=1 mask=flesh

light height dir=nw elev=38 range=-4..+4 dither=bayer4 spec=2 ao=3 ao_radius=4 shadow=8 mask=flesh,slate:4,slate:5,slate:6,slate:7,slate:3
hatch mask=flesh follow=contour angle=-25 spacing=4 shade=-1 jitter=1

# Limo com pincel de cerdas em escopo fechado
with brush bristle n=5 size=7 skip=25 shade=-1,+1 seed=42
  stroke moss:5 12,4 22,28 mask=!flesh
  stroke moss:5 104,64 114,96 mask=!flesh
end

# Olhos fullbright (índices 224..254 ficam acesos mesmo após sombreamentos globais)
sym x axis=63.5
ellipse 51 54 3 2 227 fill
pixel 51 54 231
sym off
grad shade 0 0 0 127 from=1 to=-1 dither=bayer4

lint
save skull_wall.png scale=3
```
