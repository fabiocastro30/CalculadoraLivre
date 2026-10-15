# 🚀 Calculadora Livre

[![Projeto Gratuito](https://img.shields.io/badge/Projeto-100%25%20Gratuito-00a650?style=for-the-badge)](https://github.com/fabiocastro30/CalculadoraLivre)
[![Manifest V3](https://img.shields.io/badge/Chrome%20Extension-Manifest%20V3-3483fa?style=for-the-badge)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![LinkedIn](https://img.shields.io/badge/LinkedIn-Fabio%20Castro-0A66C2?style=for-the-badge&logo=linkedin)](https://www.linkedin.com/in/fabio-castro-943649286/?isSelfProfile=true)

> **Calculadora Livre** é uma extensão para Google Chrome desenvolvida para vendedores do Mercado Livre Brasil. O projeto é **100% gratuito** e oferece ferramentas completas de precificação inteligente, auditoria de margem líquida e raio-X competitivo direto nas páginas de produto e nos resultados de busca.

---

## 👨‍💻 Sobre o Criador

Este projeto foi idealizado e desenvolvido por **Fabio Castro** com o objetivo de ajudar a comunidade de sellers a precificar melhor, entender suas margens reais e tomar decisões comerciais inteligentes sem precisar pagar por ferramentas caras de auditoria.

🔗 **Conecte-se comigo no LinkedIn:**  
👉 [linkedin.com/in/fabio-castro-943649286](https://www.linkedin.com/in/fabio-castro-943649286/?isSelfProfile=true)

---

## ✨ Principais Funcionalidades

### 1. 🔍 Análise Financeira na Página do Produto (PDP / Buybox)
- **Repasse Líquido em Destaque:** Exibe de forma clara e visível o valor exato que cairá na sua conta após descontar comissões e frete.
- **Detalhamento Preciso:**
  - Comissão do Mercado Livre (Clássico ou Premium);
  - Tarifa de frete estimada baseada na tabela de peso e faixa de preço;
  - Subsídios concedidos pelo Mercado Livre;
  - Provisão de impostos, publicidade (Ads) e custos de embalagem;
  - Sobra real limpa após todos os custos.
- **Simulador Interativo Vertical:**
  - **Meu custo do produto:** digite o custo de aquisição da mercadoria para calcular instantaneamente o lucro real e a margem percentual no preço do anúncio.
  - **Simular preço de venda:** simule qualquer preço de venda e veja na hora o novo repasse e a margem prevista.
- **Detecção de Degrau Tarifário:** Alerta quando pequenas variações de centavos reduzem tarifas de envio e aumentam seu repasse líquido.

### 2. ⚡ Inteligência Competitiva e Raio-X
- **Vendas e Velocidade:** Estimativa de unidades vendidas, média diária de vendas e faturamento mensal estimado.
- **Estoque & Atividade:** Quantidade de estoque disponível, data de criação do anúncio e dias de atividade.
- **Raio-X do Vendedor:** Identificação de reputação (MercadoLíder, Platinum, Gold), verificação de NF-e e ID do vendedor.
- **Score de Qualidade:** Checklist completo do anúncio (fotos, vídeo/clip, logística Full, reputação e avaliações).

### 3. 📊 Resultados de Busca Turbinados
- Painel compacto e moderno integrado a cada anúncio na listagem de busca.
- Visualização do repasse líquido em verde Mercado Livre.
- Exibição de comissão, frete estimado e métricas de vendas sem precisar abrir anúncio por anúncio.
- Barra lateral com ordenação inteligente dos resultados:
  - *Maior repasse líquido*
  - *Maior média de vendas diária*
  - *Maior faturamento mensal*
  - *Mais recentes primeiro*
  - *Mais antigos primeiro*

---

## 🛠️ Como Instalar no Google Chrome

Como é um projeto livre e você pode executá-lo diretamente pelo código-fonte:

1. **Baixar o Projeto:**
   - Clique no botão verde **Code** acima e depois em **Download ZIP** (ou clone este repositório via Git).
   - Extraia os arquivos para uma pasta permanente em seu computador (por exemplo: `Documentos/CalculadoraLivre`).

2. **Abrir o Gerenciador de Extensões do Chrome:**
   - Digite na barra de endereços do seu navegador: `chrome://extensions/` e pressione Enter.
   - No canto superior direito da tela, ative a chave **"Modo do desenvolvedor"**.

3. **Carregar a Extensão:**
   - Clique no botão **"Carregar sem compactação"** que apareceu no canto superior esquerdo.
   - Selecione a pasta onde estão os arquivos da extensão (a pasta que contém o arquivo `manifest.json`).

4. **Pronto para Usar!**
   - Acesse o [Mercado Livre](https://www.mercadolivre.com.br/) e navegue normalmente por produtos e buscas. A Calculadora Livre será carregada automaticamente!

---

## ⚙️ Configurações Personalizadas

Ao clicar no ícone da **Calculadora Livre** na barra de ferramentas do Chrome, você pode personalizar os parâmetros financeiros de acordo com o regime da sua empresa:
- **Alíquota de Imposto (%):** Configure a porcentagem média do Simples Nacional ou regime tributário;
- **Custo de Embalagem (R$):** Valor médio gasto com caixa, saco de envio e fita por pedido;
- **Comissão Padrão Clássico (%):** Percentual médio para anúncios Clássico (padrão: 12%);
- **Comissão Padrão Premium (%):** Percentual médio para anúncios Premium (padrão: 17%);
- **Considerar subsídios:** Opção de somar subsídios do Mercado Livre no cálculo do repasse.

---

## 📁 Estrutura do Projeto

```text
CalculadoraLivre/
├── icons/            # Ícones da extensão (16px, 32px, 48px, 128px)
├── manifest.json     # Manifesto Manifest V3 da extensão
├── content.js        # Script de injeção visual na PDP e buscas
├── page-bridge.js    # Ponte de extração de dados estruturados
├── background.js     # Service Worker para consultas em fila
├── styles.css        # Estilos com UI moderna na identidade Mercado Livre
├── popup.html        # Interface de configurações da extensão
└── popup.js          # Lógica de persistência das configurações no chrome.storage
```

---

## 🔒 Privacidade e Segurança

- **100% Local:** Todos os cálculos e processamentos ocorrem estritamente no seu próprio navegador.
- **Sem login ou senhas:** A extensão não solicita, não armazena e não envia dados pessoais, cookies, tokens ou credenciais a servidores externos.
- **Código Aberto:** O código é transparente e pode ser auditado livremente por qualquer pessoa.

---

## 📄 Aviso Legal

Este projeto é uma ferramenta open-source independente e não possui vínculo oficial com o Mercado Livre. Todas as marcas, nomes e logotipos pertencem aos seus respectivos proprietários.

---

⭐ **Gostou do projeto?** Deixe uma estrela no repositório e compartilhe com outros vendedores!  
💼 **Acompanhe mais conteúdos:** [LinkedIn de Fabio Castro](https://www.linkedin.com/in/fabio-castro-943649286/?isSelfProfile=true)
