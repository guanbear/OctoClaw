#!/usr/bin/env python3
"""Contract-first route inspection for OctoClaw.

This module no longer tries to behave like a full lightweight router.
Its job is narrower and more stable:

1. Hard-gate obvious runner work.
2. Extract execution-contract hints for policy merge.
3. Emit only a weak route bias for non-runner lanes.

Design goals:
- stable before clever
- contract-first, not task-taxonomy-first
- cheap to run
- explainable in production
- easy to improve with replay/eval feedback later

Output:
- system_preferred_route: weak initial route bias before main-brain hint merge
- route: compatibility alias for the same preferred route
- work_contract_hint: execution-contract hint used by policy/runtime
"""

from __future__ import annotations

import argparse
import json
import re
from functools import lru_cache
from typing import Iterable

from octopus_config import load_octopus_config
from worker_taxonomy import infer_worker_pool as taxonomy_infer_worker_pool


DEFAULT_ROUTE_LANGUAGE_PACKS = ("zh", "en")
OPTIONAL_ROUTE_LANGUAGE_PACKS = ("ja", "ko", "es", "pt", "ru")
SUPPORTED_ROUTE_LANGUAGE_PACKS = DEFAULT_ROUTE_LANGUAGE_PACKS + OPTIONAL_ROUTE_LANGUAGE_PACKS

RUNNER_PATTERNS = {
    "common": (
        r"\b(curl|grep|rg|tail|head|pwd|ls|find|cat|jq|sed|awk|ss|ps|top|netstat)\b",
        r"\b(cron|crontab|timer|timers|list-timers)\b",
    ),
    "zh": (
        r"(日志|端口|版本|环境变量|连通性|健康检查|进程|服务状态|端口监听|磁盘|内存|cpu|负载)",
    ),
    "en": (
        r"\b(log|logs|health|status|version|port|env|headers?|pid|process|uptime)\b",
    ),
    "ja": (
        r"(ログ|ポート|バージョン|環境変数|ヘルスチェック|プロセス|サービス状態|ディスク|メモリ|負荷)",
    ),
    "ko": (
        r"(로그|포트|버전|환경 변수|헬스 체크|프로세스|서비스 상태|디스크|메모리|부하)",
    ),
    "es": (
        r"(registros?|logs?|puerto|versión|variables? de entorno|salud|proceso|estado del servicio|disco|memoria|carga)",
    ),
    "pt": (
        r"(logs?|porta|versão|variáveis? de ambiente|saúde|processo|estado do serviço|disco|memória|carga)",
    ),
    "ru": (
        r"(логи?|порт|версия|переменные окружения|здоровье|процесс|состояние сервиса|диск|память|нагрузка)",
    ),
}

RUNNER_READ_ONLY_INTENT_PATTERNS = {
    "zh": (
        r"(看下|看一下|看看|查下|查一下|查看|搜一下|搜下|搜索|列出|显示|读取|有没有|确认一下|检查一下|正常吗)",
    ),
    "en": (
        r"\b(check|inspect|show|list|display|read|search|find|look at|verify|confirm)\b",
    ),
    "ja": (
        r"(見て|見せて|確認して|調べて|検索して|一覧|表示して|読んで|あるか)",
    ),
    "ko": (
        r"(확인해|확인해줘|봐줘|보여줘|찾아줘|검색해|읽어줘|있는지)",
    ),
    "es": (
        r"(verifica|comprueba|muestra|lista|lee|busca|encuentra|revisa)",
    ),
    "pt": (
        r"(verifique|confira|mostre|liste|leia|busque|encontre|revise)",
    ),
    "ru": (
        r"(проверь|посмотри|покажи|список|прочитай|найди|поищи|убедись)",
    ),
}

RUNNER_TARGET_PATTERNS = {
    "zh": (
        r"(日志|端口|进程|状态|文件|目录|环境变量|监听|路径|配置|版本|health|输出|cron|crontab|定时任务|计划任务|timer|timers)",
    ),
    "en": (
        r"\b(log|logs|port|ports|process|pid|status|file|files|directory|directories|env|environment|path|config|version|health|output|cron|crontab|timer|timers|scheduler)\b",
    ),
    "ja": (
        r"(ログ|ポート|プロセス|状態|ファイル|ディレクトリ|環境変数|パス|設定|バージョン|出力)",
    ),
    "ko": (
        r"(로그|포트|프로세스|상태|파일|디렉터리|환경 변수|경로|설정|버전|출력)",
    ),
    "es": (
        r"(log|logs|puerto|proceso|estado|archivo|archivos|directorio|directorios|entorno|ruta|configuración|versión|salida)",
    ),
    "pt": (
        r"(log|logs|porta|processo|estado|arquivo|arquivos|diretório|diretórios|ambiente|caminho|configuração|versão|saída)",
    ),
    "ru": (
        r"(лог|логи|порт|процесс|состояние|файл|файлы|каталог|каталоги|окружение|путь|конфиг|версия|вывод)",
    ),
}

RUNNER_NEGATIVE_PATTERNS = {
    "zh": (
        r"(修复|修改|改代码|改一下|重构|实现|开发|分析|对比|研究|方案|根因|原因|解释|总结|写文档|写一版|报告|周报|部署|重启|安装|卸载|删除|新增|创建|迁移|权限|密钥|数据库)",
    ),
    "en": (
        r"\b(fix|modify|change|patch|refactor|implement|develop|analy(?:ze|sis)|compare|research|proposal|root cause|cause|reason|explain|summary|summarize|write|report|deploy|restart|install|uninstall|delete|create|add|migrate|permission|secret|database)\b",
    ),
    "ja": (
        r"(修正|変更|コードを変更|リファクタ|実装|開発|分析|比較|調査|提案|根本原因|説明|要約|文書|レポート|デプロイ|再起動|インストール|アンインストール|削除|追加|作成|移行|権限|シークレット|データベース)",
    ),
    "ko": (
        r"(수정|변경|코드 수정|리팩터|구현|개발|분석|비교|조사|제안|근본 원인|설명|요약|문서|보고서|배포|재시작|설치|삭제|추가|생성|마이그레이션|권한|시크릿|데이터베이스)",
    ),
    "es": (
        r"(arregla|corrige|modifica|cambia|refactoriza|implementa|desarrolla|analiza|compara|investiga|propuesta|causa raíz|explica|resume|documenta|informe|despliega|reinicia|instala|desinstala|elimina|agrega|crea|migra|permisos|secreto|base de datos)",
    ),
    "pt": (
        r"(corrija|conserte|modifique|mude|refatore|implemente|desenvolva|analise|compare|pesquise|proposta|causa raiz|explique|resuma|documente|relatório|implante|reinicie|instale|desinstale|exclua|adicione|crie|migre|permissão|segredo|banco de dados)",
    ),
    "ru": (
        r"(исправь|почини|измени|модифицируй|рефактор|реализуй|разработай|проанализируй|сравни|исследуй|предложение|первопричина|объясни|суммируй|документ|отч[её]т|задеплой|перезапусти|установи|удали|добавь|создай|миграц|разрешени|секрет|база данных)",
    ),
}

MODEL_BENCHMARK_PATTERNS = {
    "zh": (
        r"(首\s*token|首token|首字延迟|首包延迟|首包|吞吐|tokens/s|token/s|tps|ttft|throughput|输出速度|响应速度)",
        r"(测速|测一下速度|测下速度|测性能|速度对比|模型测速|模型速度|延迟对比)",
    ),
    "en": (
        r"\b(first token|ttft|throughput|tokens/s|token/s|tps|latency|model speed|speed test|benchmark)\b",
    ),
}

READ_ONLY_COMMAND_PATTERNS = [
    r"^\s*(grep|rg|tail|head|pwd|ls|find|cat|jq|awk|ss|ps|top|netstat|lsof)\b",
    r"^\s*sed\b(?!.*\s-i\b)",
    r"^\s*curl\b(?!.*(?:\s-X\s*(POST|PUT|PATCH|DELETE)\b|--request\s+(POST|PUT|PATCH|DELETE)\b|--data\b|--data-raw\b|--form\b))",
]

WRITE_COMMAND_PATTERNS = [
    r"\b(rm|mv|cp|tee|truncate|touch|mkdir|rmdir|chmod|chown)\b",
    r"\bsed\s+-i\b",
    r"\b(systemctl|service)\s+(restart|start|stop|reload)\b",
    r"\b(kubectl|docker)\s+(apply|delete|restart|rm|run|exec)\b",
    r"\b(apt|yum|dnf|brew|pip|npm|pnpm|yarn)\s+(install|remove|uninstall|upgrade|update)\b",
]

CODE_PATTERNS = {
    "zh": (
        r"(写代码|改代码|修改代码|修复|bug|重构|实现|开发|review|评审|测试|回归)",
    ),
    "en": (
        r"\b(code|coding|fix|bug|refactor|implement|patch|review|test|pytest|regression)\b",
    ),
    "ja": (
        r"(コード|バグ|リファクタ|実装|レビュー|テスト|回帰)",
    ),
    "ko": (
        r"(코드|버그|리팩터|구현|리뷰|테스트|회귀)",
    ),
    "es": (
        r"(código|bug|error|refactoriza|implementa|revisión|prueba|regresión)",
    ),
    "pt": (
        r"(código|bug|erro|refatore|implemente|revisão|teste|regressão)",
    ),
    "ru": (
        r"(код|баг|ошибк|рефактор|реализуй|ревью|тест|регресс)",
    ),
}

RESEARCH_PATTERNS = {
    "zh": (
        r"(调研|对比|分析|研究|根因|方案|api|数据源|可行性)",
        r"((github|gitlab|仓库|repo|repository).*(commit|release|tag|pr|mr|issue|更新)|((commit|release|tag|pr|mr|issue|更新).*(github|gitlab|仓库|repo|repository)))",
        r"((项目|仓库).*(提交|改了啥|改了什么|变更)|((提交|改了啥|改了什么|变更).*(项目|仓库)))",
    ),
    "en": (
        r"\b(research|compare|analy|investigate|root cause|api|datasource|feasibility)\b",
        r"\b((github|gitlab|repo|repository)\b.*\b(commit|release|tag|pull request|pr|issue|updates?)\b|(\bcommit|release|tag|pull request|pr|issue|updates?\b).*\b(github|gitlab|repo|repository))",
    ),
    "ja": (
        r"(調査|比較|分析|研究|根本原因|提案|実現可能性)",
    ),
    "ko": (
        r"(조사|비교|분석|연구|근본 원인|제안|타당성)",
    ),
    "es": (
        r"(investiga|compara|analiza|investigación|causa raíz|factibilidad)",
    ),
    "pt": (
        r"(pesquise|compare|analise|pesquisa|causa raiz|viabilidade)",
    ),
    "ru": (
        r"(исследуй|сравни|проанализируй|анализ|первопричина|осуществимость)",
    ),
}

EXTERNAL_LOOKUP_PATTERNS = {
    "zh": (
        r"(天气|花粉|汇率|航班|酒店|机票|新闻|价格|行情|官网|接口文档|文档链接)",
        r"((github|gitlab|仓库|repo|repository).*(commit|release|tag|pr|mr|issue|更新)|((commit|release|tag|pr|mr|issue|更新).*(github|gitlab|仓库|repo|repository)))",
        r"((今天|今日|最近).*(有更新吗|有没有更新|更新了什么)|((有更新吗|有没有更新|更新了什么).*(github|gitlab|仓库|repo|repository)))",
        r"((项目|仓库).*(提交|改了啥|改了什么|变更)|((提交|改了啥|改了什么|变更).*(项目|仓库)))",
    ),
    "en": (
        r"\b(weather|pollen|exchange rate|flight|hotel|price|news|official docs?|documentation)\b",
        r"\b((github|gitlab|repo|repository)\b.*\b(commit|release|tag|pull request|pr|issue|updates?)\b|(\bcommit|release|tag|pull request|pr|issue|updates?\b).*\b(github|gitlab|repo|repository))",
        r"\b(any|latest|recent|today'?s)\s+updates?\b.*\b(github|gitlab|repo|repository)\b",
    ),
}

WRITE_PATTERNS = {
    "zh": (
        r"(文档|总结|报告|草稿|说明|翻译|写一篇|写一版|建议书|建议稿|写.*建议)",
    ),
    "en": (
        r"\b(doc|docs|summary|report|draft|write|translate)\b",
    ),
    "ja": (
        r"(ドキュメント|要約|レポート|下書き|説明|翻訳|書いて)",
    ),
    "ko": (
        r"(문서|요약|보고서|초안|설명|번역|작성해)",
    ),
    "es": (
        r"(documento|resumen|informe|borrador|explicación|traducción|escribe)",
    ),
    "pt": (
        r"(documento|resumo|relatório|rascunho|explicação|tradução|escreva)",
    ),
    "ru": (
        r"(документ|сводк|отч[её]т|черновик|описание|перевод|напиши)",
    ),
}

SUMMARY_OUTPUT_PATTERNS = {
    "zh": (
        r"(一句总结|三行总结|简短总结|简单总结|给我一句|给我三行|最后总结|最后给一句总结)",
    ),
    "en": (
        r"\b(one-line summary|three-line summary|brief summary|short summary)\b",
    ),
}

MULTI_STEP_PATTERNS = {
    "zh": (
        r"(先.*再|然后|最后|并给出|顺便|同时需要|分别|先查.*再)",
    ),
    "en": (
        r"\b(first.*then|then|finally|also|and give|meanwhile|in parallel)\b",
    ),
}

PARALLEL_PATTERNS = {
    "zh": (
        r"(并行|同时|分别处理|一边.*一边)",
    ),
    "en": (
        r"\b(parallel|simultaneous|separately)\b",
    ),
}

HIGH_RISK_PATTERNS = {
    "zh": (
        r"(支付|认证|鉴权|登录|数据库|迁移|权限|安全)",
        r"((生产环境|线上环境|正式环境).*(发布|上线|变更)|(发布|上线).*(生产环境|线上环境|正式环境))",
    ),
    "en": (
        r"\b(payment|auth|authentication|login|database|migration|permission|security)\b",
        r"\b((prod|production)\s+(deploy|release|rollout|change)|release\s+to\s+(prod|production)|deploy\s+to\s+(prod|production)|production\s+release)\b",
    ),
    "ja": (
        r"(本番環境|本番リリース|本番デプロイ|認証|権限|データベース|マイグレーション|セキュリティ|ログイン)",
    ),
    "ko": (
        r"(운영 환경|프로덕션 릴리스|프로덕션 배포|인증|권한|데이터베이스|마이그레이션|보안|로그인)",
    ),
    "es": (
        r"(autenticación|permisos|base de datos|migración|seguridad|inicio de sesión|despliegue a producción|release a producción)",
    ),
    "pt": (
        r"(autenticação|permissão|banco de dados|migração|segurança|login|deploy em produção|release em produção)",
    ),
    "ru": (
        r"(продакшн|релиз в прод|деплой в прод|аутентификац|разрешени|база данных|миграц|безопасност|логин)",
    ),
}

SIMPLE_DIRECT_PATTERNS = {
    "zh": (
        r"(是什么|什么意思|解释一下|简单说说|怎么理解)",
    ),
    "en": (
        r"\b(what is|explain|summarize|meaning)\b",
    ),
    "ja": (
        r"(とは|意味|説明して|簡単に教えて)",
    ),
    "ko": (
        r"(무엇|무슨 뜻|설명해줘|간단히 설명)",
    ),
    "es": (
        r"(qué es|qué significa|explica|resume)",
    ),
    "pt": (
        r"(o que é|o que significa|explique|resuma)",
    ),
    "ru": (
        r"(что такое|что значит|объясни|кратко опиши)",
    ),
}

LOCAL_STATE_PATTERNS = {
    "zh": (
        r"(这台机器|本机|服务器|机器上|当前机器|当前环境|本地环境|系统状态)",
    ),
    "en": (
        r"\b(this machine|host|server|local env|current machine|system status)\b",
    ),
    "ja": (
        r"(このマシン|このサーバー|ローカル環境|現在のマシン|システム状態)",
    ),
    "ko": (
        r"(이 머신|이 서버|로컬 환경|현재 머신|시스템 상태)",
    ),
    "es": (
        r"(esta máquina|este servidor|entorno local|máquina actual|estado del sistema)",
    ),
    "pt": (
        r"(esta máquina|este servidor|ambiente local|máquina atual|estado do sistema)",
    ),
    "ru": (
        r"(эта машина|этот сервер|локальное окружение|текущая машина|состояние системы)",
    ),
}

VERIFY_PATTERNS = {
    "zh": (
        r"(验证|确认|检查结果|回归|复现|复查|再看一下)",
    ),
    "en": (
        r"\b(verify|validation|regression|confirm|reproduce|double check)\b",
    ),
    "ja": (
        r"(検証|確認|再確認|回帰|再現|もう一度見て)",
    ),
    "ko": (
        r"(검증|확인|재확인|회귀|재현|다시 봐줘)",
    ),
    "es": (
        r"(verifica|validación|regresión|confirma|reproduce|revisa de nuevo)",
    ),
    "pt": (
        r"(verifique|validação|regressão|confirme|reproduza|revise novamente)",
    ),
    "ru": (
        r"(проверь|валидац|регресс|подтверди|воспроизведи|посмотри ещё раз)",
    ),
}

IMPLEMENT_PATTERNS = {
    "zh": (
        r"(实现|落地|接入|修复|改一下|补上|生成代码|写脚本)",
    ),
    "en": (
        r"\b(implement|integrate|fix|patch|write code|script)\b",
    ),
    "ja": (
        r"(実装|導入|統合|修正|補って|コードを書いて|スクリプトを書いて)",
    ),
    "ko": (
        r"(구현|도입|통합|수정|보완|코드 작성|스크립트 작성)",
    ),
    "es": (
        r"(implementa|integra|corrige|parchea|escribe código|script)",
    ),
    "pt": (
        r"(implemente|integre|corrija|patch|escreva código|script)",
    ),
    "ru": (
        r"(реализуй|интегрируй|исправь|патч|напиши код|скрипт)",
    ),
}

MUTATION_PATTERNS = {
    "zh": (
        r"(修改|改成|改为|更新|删除|新增|创建|写入|替换|迁移|重启|部署|安装|卸载|启用|禁用|调整)",
        r"(改cron|改配置|改任务|改脚本|改服务|更新配置|修改配置|修改任务|修改服务)",
        r"(触发并回读|更新并验证|改后验证|修后验证|重启并验证)",
    ),
    "en": (
        r"\b(modify|change|update|delete|add|create|replace|migrate|restart|deploy|install|uninstall|enable|disable|tune)\b",
        r"\b(update cron|change cron|modify cron|update config|modify config|change config|update service|modify service)\b",
    ),
    "ja": (
        r"(変更|更新|削除|追加|作成|書き込み|置換|移行|再起動|デプロイ|インストール|有効化|無効化|調整)",
    ),
    "ko": (
        r"(변경|업데이트|삭제|추가|생성|교체|마이그레이션|재시작|배포|설치|활성화|비활성화|조정)",
    ),
    "es": (
        r"(modifica|cambia|actualiza|elimina|agrega|crea|reemplaza|migra|reinicia|despliega|instala|desinstala|habilita|deshabilita|ajusta)",
    ),
    "pt": (
        r"(modifique|mude|atualize|exclua|adicione|crie|substitua|migre|reinicie|implante|instale|desinstale|habilite|desabilite|ajuste)",
    ),
    "ru": (
        r"(измени|обнови|удали|добавь|создай|замени|мигрируй|перезапусти|задеплой|установи|включи|выключи|настрой)",
    ),
}

COST_SENSITIVE_PATTERNS = {
    "zh": (
        r"(省钱|低成本|便宜点|别太贵)",
    ),
    "en": (
        r"\b(cost|cheap|budget|save money)\b",
    ),
}

SEMANTIC_AMBIGUITY_PATTERNS = {
    "zh": (
        r"(顺手|顺便|一起|同时帮我|看看要不要|必要时|如果需要|最好|更稳的方案)",
    ),
    "en": (
        r"\b(if needed|if necessary|also help|at the same time|better approach|safer approach)\b",
    ),
}

CONTINUATION_PATTERNS = {
    "zh": (
        r"(继续|接着|下一步|再查一下|再看一下|再确认一下|顺手补|顺手加|补一下|补个测试|继续处理|继续推进)",
    ),
    "en": (
        r"\b(continue|follow[- ]?up|next step|check again|look again|verify again|add tests|follow through)\b",
    ),
    "ja": (
        r"(続けて|次のステップ|もう一度見て|もう一度確認|テストを追加|続けて進めて)",
    ),
    "ko": (
        r"(계속|다음 단계|다시 확인|다시 봐줘|테스트 추가|계속 진행)",
    ),
    "es": (
        r"(continúa|siguiente paso|revisa de nuevo|verifica de nuevo|agrega pruebas|sigue)",
    ),
    "pt": (
        r"(continue|próximo passo|verifique novamente|revise novamente|adicione testes|siga)",
    ),
    "ru": (
        r"(продолжай|следующий шаг|проверь ещё раз|посмотри ещё раз|добавь тесты|продолжи)",
    ),
}

ACK_FOLLOWUP_PATTERNS = {
    "zh": (
        r"^(好|好的|好啊|好呀|行|行吧|可以|可以的|继续|继续吧|开始吧|就这样|照这个来|按这个来|没问题)[!！。.，,\s]*$",
    ),
    "en": (
        r"^(ok|okay|sounds good|go ahead|do it|please continue|continue|works for me|sgtm|looks good)[!.,\s]*$",
    ),
    "ja": (
        r"^(はい|了解|お願いします|続けて|そのままで|これでいきましょう)[!！。\s]*$",
    ),
    "ko": (
        r"^(좋아|좋아요|좋습니다|계속해|진행해|그대로 해줘|이대로 가자)[!！。\s]*$",
    ),
    "es": (
        r"^(vale|ok|de acuerdo|adelante|continúa|sigue así)[!.,\s]*$",
    ),
    "pt": (
        r"^(ok|certo|beleza|pode seguir|continue|vai em frente)[!.,\s]*$",
    ),
    "ru": (
        r"^(ок|хорошо|ладно|давай|продолжай|можно продолжать)[!.,\s]*$",
    ),
}

REMOTE_TARGET_PATTERNS = {
    "zh": (
        r"(远程|另一台机器|另一台主机|另一台机子|目标机器|目标主机|远端)",
    ),
    "en": (
        r"\b(remote|another host|another machine|target host|remote host)\b",
        r"(macmini|mac mini)",
    ),
    "ja": (
        r"(リモート|別のマシン|別のホスト|対象ホスト)",
    ),
    "ko": (
        r"(원격|다른 머신|다른 호스트|대상 호스트)",
    ),
    "es": (
        r"(remoto|otra máquina|otro host|host de destino)",
    ),
    "pt": (
        r"(remoto|outra máquina|outro host|host de destino)",
    ),
    "ru": (
        r"(удал[её]нн|другая машина|другой хост|целевой хост)",
    ),
}

OBSERVER_CONTROL_PATTERNS = {
    "zh": (
        r"(八爪鱼状态|八爪鱼队列|八爪鱼面板|任务详情|任务时间线|任务图|任务结果|任务产物|任务报告|收件箱|队列面板|任务停止|任务重试|任务批准|任务拒绝)",
    ),
    "en": (
        r"\b(octoclaw status|octoclaw queue|task details|task timeline|task graph|task retrieve|task result|task artifacts|task report|task stop|task retry|task approve|task reject|runtime status|task inbox)\b",
    ),
}

TASK_PROGRESS_PATTERNS = {
    "zh": (
        r"(好了吗|好了没|完了吗|完成了吗|处理完了吗|跑完了吗|还在跑吗|有进展吗|进度(?:怎么样|如何)?|任务(?:进度|状态)|现在(?:什么状态|到哪步了)|还没好吗)",
    ),
    "en": (
        r"\b(is it done|done yet|finished yet|still running|any progress|task status|task progress|what(?:'s| is) the status|how(?:'s| is) it going|where are we at)\b",
    ),
}

WORKFLOW_META_PATTERNS = {
    "zh": (
        r"(你是啥模型|你是什么模型|现在啥模型|当前啥模型|现在啥model|当前啥model)",
        r"(你现在是啥模型|你现在是什么模型|现在是啥模型|现在是什么模型|当前是啥模型|当前是什么模型|现在用的啥模型|现在用的什么模型|当前用的啥模型|当前用的什么模型)",
        r"(主会话模型|策略主链|主链漂移|子任务模型|当前路由|现在走的是什么路由|这次走的是什么路由)",
        r"(刚才(那次|这个)?(查询|问题|任务)?是子任务做的吗|刚才(那次|这个)?(查询|问题|任务)?是不是子任务做的|是不是子任务做的|是不是主会话自己查的|是不是主agent自己查的)",
        r"(谁查的|谁做的|谁回的|是谁处理的|谁执行的|啥模型做的|什么模型做的|是谁用什么模型做的)",
        r"(有没有走\s*(dispatch|路由|router)|走了\s*(dispatch|路由|router)\s*吗|有没有走\s*octoclaw_dispatch|判定了\s*direct\s*吗|是不是\s*direct|是不是走了\s*direct|是不是委派了|有没有委派)",
    ),
    "en": (
        r"\b(what model are you (?:on|using) now|current model|which model are you (?:on|using)|main session model|policy primary model|drifted model)\b",
        r"\b(was this delegated|was this a subtask|did this go through dispatch|did router choose direct|what route was chosen|current route|who handled this|who answered this|who ran this)\b",
    ),
}

SESSION_CONTROL_PATTERNS = {
    "zh": (
        r"(切换|切到|换到|换成|改成|改到|切换模型|切模型|换模型).{0,32}(mini\s*max|minimax|glm|gpt|claude|qwen|kimi|deepseek|gemini|sonnet|opus|m2\.7|5\.1|4\.7)",
        r"(把(当前|现在)?模型(切到|换成|改成)).{0,32}(mini\s*max|minimax|glm|gpt|claude|qwen|kimi|deepseek|gemini|sonnet|opus|m2\.7|5\.1|4\.7)",
    ),
    "en": (
        r"\b(switch|change|set)\b.{0,32}\b(model|mini\s*max|minimax|glm|gpt|claude|qwen|kimi|deepseek|gemini|sonnet|opus)\b",
    ),
}

ROUTE_PATTERN_LIBRARY = {
    "RUNNER_PATTERNS": RUNNER_PATTERNS,
    "RUNNER_READ_ONLY_INTENT_PATTERNS": RUNNER_READ_ONLY_INTENT_PATTERNS,
    "RUNNER_TARGET_PATTERNS": RUNNER_TARGET_PATTERNS,
    "RUNNER_NEGATIVE_PATTERNS": RUNNER_NEGATIVE_PATTERNS,
    "CODE_PATTERNS": CODE_PATTERNS,
    "RESEARCH_PATTERNS": RESEARCH_PATTERNS,
    "EXTERNAL_LOOKUP_PATTERNS": EXTERNAL_LOOKUP_PATTERNS,
    "WRITE_PATTERNS": WRITE_PATTERNS,
    "SUMMARY_OUTPUT_PATTERNS": SUMMARY_OUTPUT_PATTERNS,
    "MULTI_STEP_PATTERNS": MULTI_STEP_PATTERNS,
    "PARALLEL_PATTERNS": PARALLEL_PATTERNS,
    "HIGH_RISK_PATTERNS": HIGH_RISK_PATTERNS,
    "SIMPLE_DIRECT_PATTERNS": SIMPLE_DIRECT_PATTERNS,
    "LOCAL_STATE_PATTERNS": LOCAL_STATE_PATTERNS,
    "VERIFY_PATTERNS": VERIFY_PATTERNS,
    "IMPLEMENT_PATTERNS": IMPLEMENT_PATTERNS,
    "MUTATION_PATTERNS": MUTATION_PATTERNS,
    "COST_SENSITIVE_PATTERNS": COST_SENSITIVE_PATTERNS,
    "SEMANTIC_AMBIGUITY_PATTERNS": SEMANTIC_AMBIGUITY_PATTERNS,
    "CONTINUATION_PATTERNS": CONTINUATION_PATTERNS,
    "ACK_FOLLOWUP_PATTERNS": ACK_FOLLOWUP_PATTERNS,
    "REMOTE_TARGET_PATTERNS": REMOTE_TARGET_PATTERNS,
    "OBSERVER_CONTROL_PATTERNS": OBSERVER_CONTROL_PATTERNS,
    "TASK_PROGRESS_PATTERNS": TASK_PROGRESS_PATTERNS,
    "WORKFLOW_META_PATTERNS": WORKFLOW_META_PATTERNS,
    "SESSION_CONTROL_PATTERNS": SESSION_CONTROL_PATTERNS,
    "MODEL_BENCHMARK_PATTERNS": MODEL_BENCHMARK_PATTERNS,
}

MODEL_REFERENCE_REGEX = re.compile(
    r"(?:[a-z0-9_.-]+/[a-z0-9_.-]+|(?:gpt|glm|minimax|claude|qwen|kimi|deepseek|gemini|sonnet|opus)[-a-z0-9_.]*)",
    re.IGNORECASE,
)


def count_matches(text: str, patterns: Iterable[str]) -> int:
    return sum(1 for pattern in patterns if re.search(pattern, text, re.IGNORECASE))


def count_model_reference_hits(text: str) -> int:
    hits: set[str] = set()
    for value in MODEL_REFERENCE_REGEX.findall(str(text or "")):
        normalized = str(value or "").strip().lower()
        if len(normalized) >= 5:
            hits.add(normalized)
    return len(hits)


def normalize_enabled_language_packs(runtime_cfg: dict | None = None) -> tuple[str, ...]:
    packs_cfg = {}
    if isinstance(runtime_cfg, dict):
        packs_cfg = runtime_cfg.get("route_language_packs", {})
    raw_enabled = packs_cfg.get("enabled", DEFAULT_ROUTE_LANGUAGE_PACKS) if isinstance(packs_cfg, dict) else DEFAULT_ROUTE_LANGUAGE_PACKS

    enabled: list[str] = []
    seen: set[str] = set()
    for item in raw_enabled if isinstance(raw_enabled, list) else DEFAULT_ROUTE_LANGUAGE_PACKS:
        pack = str(item or "").strip().lower()
        if pack in SUPPORTED_ROUTE_LANGUAGE_PACKS and pack not in seen:
            seen.add(pack)
            enabled.append(pack)
    if not enabled:
        return DEFAULT_ROUTE_LANGUAGE_PACKS
    return tuple(enabled)


@lru_cache(maxsize=256)
def resolve_language_patterns(name: str, enabled_packs: tuple[str, ...]) -> tuple[str, ...]:
    patterns_by_pack = ROUTE_PATTERN_LIBRARY.get(name, {})
    resolved: list[str] = list(patterns_by_pack.get("common", ()))
    for pack in enabled_packs:
        resolved.extend(patterns_by_pack.get(pack, ()))
    return tuple(resolved)


def command_looks_read_only(command: str) -> bool:
    cmd = (command or "").strip()
    if not cmd:
        return False
    if any(re.search(pattern, cmd, re.IGNORECASE) for pattern in WRITE_COMMAND_PATTERNS):
        return False
    return any(re.search(pattern, cmd, re.IGNORECASE) for pattern in READ_ONLY_COMMAND_PATTERNS)


def extract_features(task: str, command: str = "", runtime_cfg: dict | None = None) -> dict:
    raw_task = (task or "").strip()
    text = raw_task.lower()
    command = (command or "").strip()
    enabled_packs = normalize_enabled_language_packs(runtime_cfg)
    explicit_local_probe = bool(
        re.search(r"/[A-Za-z0-9._/\-]+", raw_task)
        or re.search(r"(?:最近|近)\s*\d{1,4}\s*行", raw_task)
        or re.search(r"\btail\s+-n?\s*\d{1,4}\b", text)
        or re.search(r"\b\d{2,5}\s*(?:端口|port)\b", text)
    )

    runner_hits = count_matches(text, resolve_language_patterns("RUNNER_PATTERNS", enabled_packs))
    code_hits = count_matches(text, resolve_language_patterns("CODE_PATTERNS", enabled_packs))
    research_hits = count_matches(text, resolve_language_patterns("RESEARCH_PATTERNS", enabled_packs))
    external_lookup_hits = count_matches(text, resolve_language_patterns("EXTERNAL_LOOKUP_PATTERNS", enabled_packs))
    write_hits = count_matches(text, resolve_language_patterns("WRITE_PATTERNS", enabled_packs))
    summary_output_hits = count_matches(text, resolve_language_patterns("SUMMARY_OUTPUT_PATTERNS", enabled_packs))
    multi_step_hits = count_matches(text, resolve_language_patterns("MULTI_STEP_PATTERNS", enabled_packs))
    parallel_hits = count_matches(text, resolve_language_patterns("PARALLEL_PATTERNS", enabled_packs))
    high_risk_hits = count_matches(text, resolve_language_patterns("HIGH_RISK_PATTERNS", enabled_packs))
    simple_hits = count_matches(text, resolve_language_patterns("SIMPLE_DIRECT_PATTERNS", enabled_packs))
    local_state_hits = count_matches(text, resolve_language_patterns("LOCAL_STATE_PATTERNS", enabled_packs))
    verify_hits = count_matches(text, resolve_language_patterns("VERIFY_PATTERNS", enabled_packs))
    implement_hits = count_matches(text, resolve_language_patterns("IMPLEMENT_PATTERNS", enabled_packs))
    mutation_hits = count_matches(text, resolve_language_patterns("MUTATION_PATTERNS", enabled_packs))
    cost_sensitive_hits = count_matches(text, resolve_language_patterns("COST_SENSITIVE_PATTERNS", enabled_packs))
    semantic_ambiguity_hits = count_matches(text, resolve_language_patterns("SEMANTIC_AMBIGUITY_PATTERNS", enabled_packs))
    continuation_hits = count_matches(text, resolve_language_patterns("CONTINUATION_PATTERNS", enabled_packs))
    ack_followup_hits = count_matches(text, resolve_language_patterns("ACK_FOLLOWUP_PATTERNS", enabled_packs))
    remote_target_hits = count_matches(text, resolve_language_patterns("REMOTE_TARGET_PATTERNS", enabled_packs))
    runner_read_only_intent_hits = count_matches(text, resolve_language_patterns("RUNNER_READ_ONLY_INTENT_PATTERNS", enabled_packs))
    runner_target_hits = count_matches(text, resolve_language_patterns("RUNNER_TARGET_PATTERNS", enabled_packs))
    runner_negative_hits = count_matches(text, resolve_language_patterns("RUNNER_NEGATIVE_PATTERNS", enabled_packs))
    observer_control_hits = count_matches(text, resolve_language_patterns("OBSERVER_CONTROL_PATTERNS", enabled_packs))
    task_progress_hits = count_matches(text, resolve_language_patterns("TASK_PROGRESS_PATTERNS", enabled_packs))
    workflow_meta_hits = count_matches(text, resolve_language_patterns("WORKFLOW_META_PATTERNS", enabled_packs))
    session_control_hits = count_matches(text, resolve_language_patterns("SESSION_CONTROL_PATTERNS", enabled_packs))
    model_benchmark_hits = count_matches(text, resolve_language_patterns("MODEL_BENCHMARK_PATTERNS", enabled_packs))
    model_reference_hits = count_model_reference_hits(text)
    command_read_only = command_looks_read_only(command)
    explicit_observer_command = bool(
        re.fullmatch(r"\s*(?:八爪鱼状态|八爪鱼队列|八爪鱼面板)\s*", raw_task, re.IGNORECASE)
        or re.fullmatch(r"\s*(?:queue|inbox)\s*", raw_task, re.IGNORECASE)
        or re.fullmatch(r"\s*(?:details?|view|retrieve|result|graph|timeline|artifacts?|stop|retry|approve|reject)\s+[A-Za-z0-9._:/-]+\s*", raw_task, re.IGNORECASE)
        or re.fullmatch(r"\s*(?:任务详情|任务时间线|任务图|任务结果|任务产物|任务报告|任务停止|任务重试|任务批准|任务拒绝)\s+[A-Za-z0-9._:/-]+\s*", raw_task, re.IGNORECASE)
    )
    workflow_meta_candidate = workflow_meta_hits > 0
    session_control_candidate = bool(session_control_hits > 0)
    observer_control_candidate = bool(explicit_observer_command or observer_control_hits > 0 or workflow_meta_candidate)
    model_benchmark_candidate = bool(model_benchmark_hits > 0 and model_reference_hits > 0 and not workflow_meta_candidate and not session_control_candidate)
    repo_activity_lookup = bool(
        (
            re.search(r"(github|gitlab|仓库|repo|repository|项目)", text, re.IGNORECASE)
            and re.search(r"(commit|release|tag|pr|mr|issue|更新|提交|改了啥|改了什么|变更)", text, re.IGNORECASE)
            and re.search(r"(有没有|有更新吗|更新了什么|今天|今日|最近|latest|recent|today|updates?)", text, re.IGNORECASE)
        )
        or (
            re.search(r"(项目|仓库)", text, re.IGNORECASE)
            and re.search(r"(提交|改了啥|改了什么|变更)", text, re.IGNORECASE)
        )
    )

    effective_research_hits = research_hits
    effective_external_lookup_hits = external_lookup_hits
    effective_mutation_hits = mutation_hits
    if repo_activity_lookup:
        effective_research_hits = max(effective_research_hits, 1)
        effective_external_lookup_hits = max(effective_external_lookup_hits, 1)
        effective_mutation_hits = 0

    effective_code_hits = code_hits
    effective_local_state_hits = local_state_hits
    effective_runner_negative_hits = runner_negative_hits
    if model_benchmark_candidate:
        effective_code_hits = 0
        effective_research_hits = 0
        effective_mutation_hits = 0
        effective_local_state_hits = max(effective_local_state_hits, 1)
        effective_runner_negative_hits = 0

    effective_write_hits = write_hits
    if summary_output_hits > 0 and effective_code_hits == 0 and effective_research_hits == 0 and effective_mutation_hits == 0:
        effective_write_hits = 0
    if (
        explicit_local_probe
        and runner_read_only_intent_hits > 0
        and runner_target_hits > 0
        and effective_code_hits == 0
        and effective_research_hits == 0
        and effective_mutation_hits == 0
    ):
        effective_write_hits = 0
    if model_benchmark_candidate:
        effective_write_hits = 0

    short_ack_candidate = (
        ack_followup_hits > 0
        and len(raw_task) <= 48
        and not command
        and runner_hits == 0
        and runner_read_only_intent_hits == 0
        and runner_target_hits == 0
        and effective_runner_negative_hits == 0
        and effective_code_hits == 0
        and effective_research_hits == 0
        and effective_write_hits == 0
        and summary_output_hits == 0
        and multi_step_hits == 0
        and parallel_hits == 0
        and high_risk_hits == 0
        and effective_local_state_hits == 0
        and remote_target_hits == 0
        and verify_hits == 0
        and implement_hits == 0
        and effective_mutation_hits == 0
    )

    task_progress_candidate = bool(
        task_progress_hits > 0
        and len(raw_task) <= 80
        and not command
        and runner_hits == 0
        and code_hits == 0
        and research_hits == 0
        and effective_write_hits == 0
        and summary_output_hits == 0
        and multi_step_hits == 0
        and parallel_hits == 0
        and high_risk_hits == 0
        and verify_hits == 0
        and implement_hits == 0
        and mutation_hits == 0
    )

    estimated_steps = 1
    if multi_step_hits > 0:
        estimated_steps += 1
    if effective_research_hits > 0:
        estimated_steps += 1
    if effective_code_hits > 0:
        estimated_steps += 1
    if effective_write_hits > 0:
        estimated_steps += 1
    if parallel_hits > 0:
        estimated_steps += 1
    if verify_hits > 0:
        estimated_steps += 1
    if effective_mutation_hits > 0:
        estimated_steps += 1
    if len(raw_task) > 140:
        estimated_steps += 1

    task_shape = "single_step"
    if estimated_steps >= 4 or parallel_hits > 0:
        task_shape = "staged"
    elif estimated_steps >= 2:
        task_shape = "multi_step"

    context_growth = "low"
    if effective_code_hits > 0 or effective_local_state_hits > 0 or verify_hits > 0 or effective_mutation_hits > 0:
        context_growth = "medium"
    if estimated_steps >= 4 or effective_mutation_hits > 0 or (effective_research_hits > 0 and (effective_code_hits > 0 or write_hits > 0)):
        context_growth = "high"

    latency_sensitivity = "normal"
    if effective_local_state_hits > 0 or command:
        latency_sensitivity = "high"
    elif effective_external_lookup_hits > 0 and effective_research_hits == 0 and effective_code_hits == 0:
        latency_sensitivity = "normal"

    observer_control_candidate = bool(
        explicit_observer_command
        or observer_control_hits > 0
        or workflow_meta_candidate
        or task_progress_candidate
    )
    observation_signal = observer_control_candidate or model_benchmark_candidate or bool(command) or runner_hits > 0 or effective_local_state_hits > 0 or remote_target_hits > 0 or (
        runner_read_only_intent_hits > 0 and runner_target_hits > 0
    )

    features = {
        "task_length": len(raw_task),
        "route_language_packs": list(enabled_packs),
        "has_command": bool(command),
        "command_read_only": command_read_only,
        "runner_hits": runner_hits,
        "runner_read_only_intent_hits": runner_read_only_intent_hits,
        "runner_target_hits": runner_target_hits,
        "runner_negative_hits": effective_runner_negative_hits,
        "observer_control_hits": observer_control_hits,
        "task_progress_hits": task_progress_hits,
        "observer_control_candidate": observer_control_candidate,
        "task_progress_candidate": task_progress_candidate,
        "workflow_meta_hits": workflow_meta_hits,
        "workflow_meta_candidate": workflow_meta_candidate,
        "session_control_hits": session_control_hits,
        "session_control_candidate": session_control_candidate,
        "model_benchmark_hits": model_benchmark_hits,
        "model_reference_hits": model_reference_hits,
        "model_benchmark_candidate": model_benchmark_candidate,
        "explicit_local_probe": explicit_local_probe,
        "code_hits": effective_code_hits,
        "research_hits": effective_research_hits,
        "external_lookup_hits": effective_external_lookup_hits,
        "write_hits": write_hits,
        "summary_output_hits": summary_output_hits,
        "multi_step_hits": multi_step_hits,
        "parallel_hits": parallel_hits,
        "high_risk_hits": high_risk_hits,
        "simple_hits": simple_hits,
        "local_state_hits": effective_local_state_hits,
        "verify_hits": verify_hits,
        "implement_hits": implement_hits,
        "mutation_hits": effective_mutation_hits,
        "repo_activity_hits": 1 if repo_activity_lookup else 0,
        "cost_sensitive_hits": cost_sensitive_hits,
        "semantic_ambiguity_hits": semantic_ambiguity_hits,
        "continuation_hits": continuation_hits,
        "ack_followup_hits": ack_followup_hits,
        "remote_target_hits": remote_target_hits,
        "requires_tools": observation_signal,
        "requires_code_work": effective_code_hits > 0,
        "requires_research": effective_research_hits > 0,
        "requires_mutation": effective_mutation_hits > 0 or (implement_hits > 0 and (effective_code_hits > 0 or effective_local_state_hits > 0)),
        "external_lookup_only": effective_external_lookup_hits > 0 and effective_research_hits == 0 and effective_code_hits == 0 and write_hits == 0,
        "requires_writing": effective_write_hits > 0,
        "estimated_steps": estimated_steps,
        "task_shape": task_shape,
        "multi_step": estimated_steps >= 2,
        "parallelizable": (
            parallel_hits > 0
            or (effective_research_hits > 0 and write_hits > 0 and multi_step_hits > 0)
            or (verify_hits > 0 and (effective_code_hits > 0 or implement_hits > 0))
        ),
        "tool_observation_only": (
            observation_signal
            and effective_mutation_hits == 0
            and implement_hits == 0
            and effective_code_hits == 0
            and effective_research_hits == 0
            and effective_write_hits == 0
        ),
        "target_scope": "remote" if remote_target_hits > 0 else ("local" if effective_local_state_hits > 0 else "generic"),
        "high_risk": high_risk_hits > 0,
        "ack_followup_candidate": short_ack_candidate,
        "followup_candidate": continuation_hits > 0 or short_ack_candidate,
        "context_growth": context_growth,
        "latency_sensitivity": latency_sensitivity,
        "simple_direct_candidate": simple_hits > 0 and runner_hits == 0 and effective_code_hits == 0 and effective_research_hits == 0 and effective_local_state_hits == 0,
    }
    features["hard_runner_candidate"] = bool(
        not observer_control_candidate
        and effective_runner_negative_hits == 0
        and not features["high_risk"]
        and not features["parallelizable"]
        and features["simple_hits"] == 0
        and features["summary_output_hits"] == 0
        and not features["requires_mutation"]
        and not features["requires_code_work"]
        and not features["requires_research"]
        and not features["requires_writing"]
        and features["estimated_steps"] <= 2
        and (
            model_benchmark_candidate
            or command_read_only
            or (
                runner_read_only_intent_hits > 0
                and (runner_target_hits > 0 or runner_hits > 0 or effective_local_state_hits > 0 or remote_target_hits > 0)
            )
            or (
                features["tool_observation_only"]
                and runner_target_hits > 0
                and (runner_read_only_intent_hits > 0 or runner_hits > 0 or effective_local_state_hits > 0)
            )
        )
    )
    return features


def direct_contract_candidate(features: dict) -> bool:
    if features.get("high_risk"):
        return False
    if features.get("session_control_candidate"):
        return True
    if features.get("observer_control_candidate"):
        return True
    if features.get("requires_tools"):
        return False
    if features.get("requires_mutation"):
        return False
    if features.get("requires_code_work"):
        return False
    if features.get("parallelizable"):
        return False
    if int(features.get("estimated_steps", 0) or 0) >= 3:
        return False
    if features.get("requires_research") and not features.get("external_lookup_only"):
        return False
    if features.get("requires_writing") and not features.get("summary_output_hits"):
        return False
    if features.get("context_growth") in {"medium", "high"}:
        return False
    return bool(
        features.get("simple_direct_candidate")
        or features.get("external_lookup_only")
        or (
            int(features.get("task_length", 0) or 0) <= 120
            and int(features.get("estimated_steps", 0) or 0) <= 2
            and not features.get("requires_research")
            and not features.get("requires_writing")
        )
    )


def infer_parallel_gain_band(features: dict) -> str:
    if int(features.get("parallel_hits", 0) or 0) > 0:
        return "high"
    if features.get("parallelizable") and (
        int(features.get("estimated_steps", 0) or 0) >= 5
        or (features.get("requires_code_work") and int(features.get("verify_hits", 0) or 0) > 0)
    ):
        return "high"
    if features.get("parallelizable") or int(features.get("estimated_steps", 0) or 0) >= 4:
        return "medium"
    return "low"


def coordinated_work_candidate(features: dict) -> bool:
    if not features.get("parallelizable"):
        return False
    if int(features.get("parallel_hits", 0) or 0) > 0:
        return True
    if int(features.get("estimated_steps", 0) or 0) >= 5:
        return True
    if features.get("requires_code_work") and int(features.get("verify_hits", 0) or 0) > 0 and int(
        features.get("estimated_steps", 0) or 0
    ) >= 4:
        return True
    if features.get("high_risk") and int(features.get("estimated_steps", 0) or 0) >= 4:
        return True
    return False


def infer_work_contract_hint(features: dict, route: str | None = None) -> str:
    if route == "runner" or features.get("hard_runner_candidate"):
        return "inspect_report"
    if features.get("model_benchmark_candidate"):
        return "inspect_report"
    if features.get("session_control_candidate"):
        return "answer_now"
    if features.get("observer_control_candidate"):
        return "answer_now"
    if direct_contract_candidate(features):
        return "answer_now"
    if coordinated_work_candidate(features):
        return "coordinated_work"
    if features.get("tool_observation_only"):
        return "inspect_report"
    if int(features.get("summary_output_hits", 0) or 0) > 0:
        return "deliverable_work"
    return "deliverable_work"


def contract_driven_route_bias(features: dict, work_contract_hint: str) -> tuple[str, dict[str, float], list[str], float]:
    scores = {
        "direct": 0.0,
        "runner": 0.0,
        "spawn_single": 0.0,
        "spawn_multi": 0.0,
    }
    reason_codes: list[str] = [f"work_contract:{work_contract_hint}"]

    if work_contract_hint == "answer_now":
        scores["direct"] = 0.82
        scores["spawn_single"] = 0.36
        if features.get("session_control_candidate"):
            scores["direct"] = 0.97
            scores["spawn_single"] = 0.04
            reason_codes.append("session_control_direct_contract")
        elif features.get("observer_control_candidate"):
            scores["direct"] = 0.96
            scores["spawn_single"] = 0.08
            if features.get("workflow_meta_candidate"):
                reason_codes.append("workflow_meta_control_contract")
            else:
                reason_codes.append("observer_control_contract")
        elif features.get("external_lookup_only"):
            reason_codes.append("direct_lookup_contract")
        else:
            reason_codes.append("direct_answer_contract")
    elif work_contract_hint == "inspect_report":
        scores["spawn_single"] = 0.72
        scores["runner"] = 0.44
        reason_codes.append("inspect_report_contract")
        if features.get("requires_tools"):
            reason_codes.append("tool_observation_contract")
        if features.get("tool_observation_only"):
            scores["runner"] = 0.82
            scores["spawn_single"] = 0.54
            reason_codes.append("tool_observation_only")
    elif work_contract_hint == "coordinated_work":
        scores["spawn_multi"] = 0.78
        scores["spawn_single"] = 0.67
        reason_codes.append("coordinated_work_contract")
        reason_codes.append(f"parallel_gain:{infer_parallel_gain_band(features)}")
    else:
        scores["spawn_single"] = 0.82
        scores["direct"] = 0.08
        reason_codes.append("deliverable_work_contract")

    if features.get("high_risk"):
        scores["direct"] = max(0.0, scores["direct"] - 0.4)
        scores["spawn_single"] += 0.08
        scores["spawn_multi"] += 0.08
        reason_codes.append("high_risk")

    if features.get("requires_mutation"):
        scores["direct"] = 0.0
        scores["runner"] = max(0.0, scores["runner"] - 0.35)
        scores["spawn_single"] += 0.18
        reason_codes.append("mutation_work")

    if features.get("requires_code_work"):
        scores["direct"] = 0.0
        scores["spawn_single"] += 0.14
        reason_codes.append("code_work")

    if features.get("requires_research"):
        scores["direct"] = max(0.0, scores["direct"] - 0.18)
        scores["spawn_single"] += 0.08
        reason_codes.append("research_work")

    if features.get("requires_writing"):
        scores["runner"] = max(0.0, scores["runner"] - 0.18)
        scores["spawn_single"] += 0.08
        reason_codes.append("writing_work")

    if features.get("multi_step"):
        scores["spawn_single"] += 0.06
        reason_codes.append("multi_step")

    if features.get("parallelizable"):
        scores["spawn_multi"] += 0.06
        reason_codes.append("parallelizable")

    route = max(scores, key=scores.get)
    if work_contract_hint == "inspect_report":
        if features.get("model_benchmark_candidate"):
            route = "runner"
            reason_codes.append("prefer_runner_for_model_benchmark")
        elif features.get("explicit_local_probe") or features.get("hard_runner_candidate"):
            route = "runner"
            reason_codes.append("prefer_runner_for_explicit_probe")
        else:
            route = "spawn_single"
            reason_codes.append("prefer_spawn_single_over_soft_runner_bias")
    if work_contract_hint == "coordinated_work" and infer_parallel_gain_band(features) == "medium":
        route = "spawn_single"
        reason_codes.append("prefer_spawn_single_over_weak_multi_bias")
    if work_contract_hint == "answer_now" and not direct_contract_candidate(features):
        route = "spawn_single"
        reason_codes.append("direct_contract_veto_to_spawn_single")
    if features.get("session_control_candidate"):
        route = "direct"
        reason_codes.append("prefer_direct_session_control_lane")
    elif features.get("observer_control_candidate"):
        route = "direct"
        reason_codes.append("prefer_direct_control_lane")

    ordered_scores = sorted(scores.values(), reverse=True)
    top_score = ordered_scores[0] if ordered_scores else 0.0
    second_score = ordered_scores[1] if len(ordered_scores) > 1 else 0.0
    confidence = round(min(1.0, top_score), 3)
    score_margin = round(top_score - second_score, 3)
    return route, {key: round(value, 3) for key, value in scores.items()}, reason_codes, max(score_margin, 0.0)


def infer_work_type_hint(features: dict, route: str, work_contract_hint: str = "") -> str:
    if route == "runner":
        return "ops"
    if work_contract_hint == "inspect_report":
        return "review" if features["verify_hits"] > 0 else "research"
    if features["verify_hits"] > 0 and not features["requires_mutation"]:
        return "review"
    if features["requires_mutation"] or features["requires_code_work"]:
        return "code"
    return "research"


def infer_phase_hint(features: dict, route: str, work_type: str, work_contract_hint: str = "") -> str:
    if route == "runner":
        return "inspect"
    if work_contract_hint == "inspect_report" and work_type == "research":
        return "inspect"
    if work_type == "review":
        return "verify"
    if work_type == "code":
        return "implement"
    if features["requires_writing"] or features["summary_output_hits"] > 0:
        return "report"
    if features["high_risk"]:
        return "inspect"
    return "collect"


def infer_model_band_hint(features: dict, route: str, work_type: str) -> str:
    if route == "runner":
        return "fast"
    if route == "spawn_multi":
        return "strong"
    if features["high_risk"]:
        return "strong"
    if features["estimated_steps"] >= 5 or (features["parallelizable"] and features["estimated_steps"] >= 3):
        return "heavy"
    if work_type == "review":
        return "strong"
    if work_type == "code" and (features["requires_mutation"] or features["verify_hits"] > 0):
        return "strong"
    if features["requires_code_work"] or features["requires_research"] or features["requires_writing"] or features["summary_output_hits"] > 0:
        return "normal"
    return "fast" if route == "direct" else "normal"


def expected_latency_ms(route: str, features: dict) -> int:
    if route == "runner":
        return 1500 if features["estimated_steps"] <= 2 else 3500
    if route == "direct":
        return 1200 if features["task_length"] <= 80 else 3500
    if route == "spawn_single":
        return 12000 if features["requires_code_work"] else 9000
    return 18000


def expected_cost_band(route: str, features: dict) -> str:
    if route == "runner":
        return "low"
    if route == "direct":
        return "low" if not features["requires_research"] else "medium"
    if route == "spawn_single":
        return "medium"
    return "high"


def infer_task_class(features: dict, route: str) -> str:
    if route == "direct" and features.get("session_control_candidate"):
        return "session_control"
    if route == "direct" and features.get("observer_control_candidate"):
        return "control_observer"
    if route == "runner":
        if features.get("target_scope") == "remote":
            return "fast_remote_check"
        if features.get("target_scope") == "local":
            return "fast_local_check"
        return "fast_tool_check"
    if features["requires_mutation"] and route.startswith("spawn"):
        return "focused_local_change"
    if route == "direct" and features["external_lookup_only"]:
        return "simple_lookup"
    if route == "direct":
        return "direct_answer"
    if route == "spawn_multi":
        return "staged_workflow"
    if features["requires_code_work"]:
        return "focused_code_work"
    if features["requires_research"]:
        return "focused_research"
    return "focused_subtask"


def infer_execution_owner(route: str) -> str:
    if route == "direct":
        return "main_agent"
    if route == "runner":
        return "persistent_runner"
    return "subagent"


def infer_protected_lane(features: dict, route: str, task_class: str) -> str:
    if route == "direct" and task_class == "session_control":
        return "session_control"
    if route == "direct" and task_class == "control_observer":
        return "control_observer"
    if route == "direct" and features.get("workflow_meta_candidate"):
        return "workflow_meta"
    return ""


def choose_semantic_model_hint() -> str:
    try:
        from octopus_config import MODEL_POLICY_FILE, load_json  # lazy import to keep route script cheap

        policy = load_json(MODEL_POLICY_FILE)
        if isinstance(policy, dict):
            worker_pools = policy.get("worker_pools", {})
            if isinstance(worker_pools, dict):
                model_id = str(worker_pools.get("octoclaw-runner", "") or "")
                if model_id:
                    return model_id
            main_model = str(policy.get("main_model", "") or "")
            if main_model:
                return main_model
    except Exception:
        pass
    return "minimax-portal/MiniMax-M2.7-highspeed"


def should_request_semantic_review(features: dict, scores: dict, route: str, work_contract_hint: str) -> tuple[bool, float, str]:
    ordered = sorted(scores.items(), key=lambda item: item[1], reverse=True)
    if len(ordered) < 2:
        return False, 1.0, ""
    top_route, top_score = ordered[0]
    second_route, second_score = ordered[1]
    margin = round(float(top_score) - float(second_score), 3)

    if route == "direct":
        return False, margin, ""

    if features["requires_mutation"] and route == "runner":
        return True, margin, "mutation_vs_runner"

    if work_contract_hint == "inspect_report" and not features.get("hard_runner_candidate"):
        if features["requires_research"] or features["requires_writing"] or features["semantic_ambiguity_hits"] > 0:
            return True, margin, "inspect_report_boundary"

    if work_contract_hint == "coordinated_work" and infer_parallel_gain_band(features) == "medium":
        return True, margin, "single_vs_multi_boundary"

    if features["semantic_ambiguity_hits"] > 0 and margin < 0.55:
        return True, margin, "ambiguous_task_shape"

    if features["requires_research"] and features["requires_tools"] and margin < 0.6:
        return True, margin, "research_with_tools"

    if features["estimated_steps"] >= 3 and top_route != second_route and margin < 0.45:
        return True, margin, "close_score_multi_step"

    return False, margin, ""


def hard_gate_route(features: dict, runtime_cfg: dict | None = None) -> tuple[str | None, list[str]]:
    reasons: list[str] = []
    switches = runtime_cfg.get("switches", {}) if isinstance(runtime_cfg, dict) else {}
    if not bool(switches.get("hard_runner_only", True)):
        return None, reasons

    if features.get("hard_runner_candidate"):
        reasons.append("hard_runner_only")
        if features.get("model_benchmark_candidate"):
            reasons.append("model_benchmark_workflow")
        if features.get("command_read_only"):
            reasons.append("read_only_command")
        if features.get("runner_read_only_intent_hits", 0) > 0:
            reasons.append("read_only_runner_intent")
        if features.get("runner_target_hits", 0) > 0:
            reasons.append("runner_target_detected")
        if features.get("target_scope") == "remote":
            reasons.append("remote_read_only_probe")
        elif features.get("target_scope") == "local":
            reasons.append("local_read_only_probe")
        return "runner", reasons

    return None, reasons


def infer_route(task: str, command: str = "") -> dict:
    runtime_cfg = load_octopus_config().get("runtime_policy", {})
    enabled_packs = normalize_enabled_language_packs(runtime_cfg)
    features = extract_features(task, command, runtime_cfg=runtime_cfg)

    hard_route, hard_reasons = hard_gate_route(features, runtime_cfg=runtime_cfg)
    if hard_route:
        route = hard_route
        work_contract_hint = infer_work_contract_hint(features, route=hard_route)
        scores = {"direct": 0.0, "runner": 0.0, "spawn_single": 0.0, "spawn_multi": 0.0}
        scores[route] = 1.0
        reason_codes = [*hard_reasons, f"work_contract:{work_contract_hint}"]
        score_margin = 1.0
        confidence = 0.92 if route in ("runner", "direct") else 0.88
    else:
        work_contract_hint = infer_work_contract_hint(features)
        route, scores, reason_codes, score_margin = contract_driven_route_bias(features, work_contract_hint)
        confidence = round(min(1.0, max(scores.values())), 3)

    needs_semantic_review, score_margin, semantic_reason = should_request_semantic_review(features, scores, route, work_contract_hint)
    semantic_model_hint = choose_semantic_model_hint() if needs_semantic_review else ""

    work_type_hint = infer_work_type_hint(features, route, work_contract_hint)
    phase_hint = infer_phase_hint(features, route, work_type_hint, work_contract_hint)
    worker_pool_hint = taxonomy_infer_worker_pool(route, work_type_hint)
    model_band_hint = infer_model_band_hint(features, route, work_type_hint)
    task_class = infer_task_class(features, route)
    protected_lane = infer_protected_lane(features, route, task_class)
    parallel_gain_band = infer_parallel_gain_band(features)
    needs_durable_runtime = route != "direct" or work_contract_hint in {"deliverable_work", "coordinated_work"}
    needs_artifact = work_contract_hint in {"inspect_report", "deliverable_work", "coordinated_work"}
    should_wait = route == "runner"
    wait_timeout_seconds = 0
    if route == "runner":
        wait_timeout_seconds = 8 if features["estimated_steps"] <= 2 else 12

    return {
        "system_preferred_route": route,
        "route": route,
        "route_language_packs": list(enabled_packs),
        "confidence": confidence,
        "reason": reason_codes[0] if reason_codes else "default_route",
        "reasons": reason_codes,
        "reason_codes": reason_codes,
        "scores": scores,
        "features": features,
        "task_class": task_class,
        "protected_lane": protected_lane,
        "work_contract_hint": work_contract_hint,
        "worker_pool_hint": worker_pool_hint,
        "work_type_hint": work_type_hint,
        "phase_hint": phase_hint,
        "model_band_hint": model_band_hint,
        "parallel_gain_band": parallel_gain_band,
        "needs_durable_runtime": needs_durable_runtime,
        "needs_artifact": needs_artifact,
        "expected_latency_ms": expected_latency_ms(route, features),
        "expected_cost_band": expected_cost_band(route, features),
        "context_growth_band": features["context_growth"],
        "execution_owner": infer_execution_owner(route),
        "dispatch_required": route != "direct",
        "main_agent_can_execute_directly": route == "direct",
        "should_wait": should_wait,
        "wait_timeout_seconds": wait_timeout_seconds,
        "needs_semantic_review": needs_semantic_review,
        "semantic_review_reason": semantic_reason,
        "score_margin": score_margin,
        "semantic_model_hint": semantic_model_hint,
        "source": (task or "").strip(),
    }


def main():
    parser = argparse.ArgumentParser(description="Deterministic OctoClaw route decision")
    parser.add_argument("--task", required=True)
    parser.add_argument("--command", default="")
    args = parser.parse_args()
    print(json.dumps(infer_route(args.task, args.command), ensure_ascii=False))


if __name__ == "__main__":
    main()
