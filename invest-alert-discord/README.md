# Radar de preços para Discord

Um verificador agendado que consulta ativos da B3, compara o preço atual com a média dos fechamentos recentes e publica alertas em um canal do Discord. O processo roda no GitHub Actions; não precisa deixar um computador ligado.

## Regras iniciais

- Verifica uma vez por hora em dias úteis, das 10h às 17h de Brasília.
- Começa com MXRF11, CPSH11, GARE11 e GGRC11 como exemplos. Edite `watchlist.json` para escolher os ativos atuais.
- Usa a média simples dos últimos 60 fechamentos disponíveis. Esse período cabe no histórico do plano gratuito da fonte escolhida.
- Avisa quando o preço fica abaixo da média. Só avisa novamente se cair pelo menos 1% em relação ao último preço alertado.
- Se um ativo voltar para a média ou acima dela, o próximo cruzamento para baixo pode gerar um novo alerta.
- Agrupa todos os novos alertas em uma mensagem por verificação.

## Dados

O projeto consulta a API da brapi. O plano gratuito tem cotações com atraso aproximado e histórico limitado a três meses. A verificação horária não transforma esse dado em cotação em tempo real; a mensagem mostra o horário informado pela API. Confirme os termos e os limites atuais do provedor antes de usar.

O histórico é buscado automaticamente; não é necessário preparar um JSON de preços. `data/state.json` guarda apenas os preços dos últimos alertas para evitar mensagens repetidas.

## Instalação resumida

1. Crie um repositório **privado** no GitHub e envie estes arquivos.
2. No Discord, crie um webhook no canal que receberá os avisos.
3. Em **Settings → Secrets and variables → Actions**, crie os secrets:
   - `DISCORD_WEBHOOK_URL`: URL do webhook do canal.
   - `BRAPI_TOKEN`: token da API brapi.
4. Em **Actions**, habilite workflows e execute `Verificar oportunidades` uma vez manualmente para testar.
5. O agendamento automático já está em `.github/workflows/monitor.yml`.

Não cole tokens no código, no README ou em mensagens. Use somente os Secrets do GitHub.

## Teste local opcional

Requer Node.js 20+. Copie `.env.example` para `.env`, preencha os valores e rode:

```sh
node check.mjs
```

## Limites conhecidos

- A média é um indicador histórico, não uma estimativa garantida de valor justo nem recomendação de compra.
- O preço pode estar atrasado em relação à B3.
- A agenda do GitHub pode iniciar alguns minutos depois do horário marcado.
- No teste manual, a execução respeita a janela do pregão; use `FORCE_RUN=true` para testar fora dela.
