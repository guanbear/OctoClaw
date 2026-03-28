#!/usr/bin/env python3
"""System-preferred task router for OctoClaw.

This module is not a keyword toy router. It is a lightweight orchestration
preference layer that tries to answer three questions, in order:

1. Should the main agent handle this directly?
2. If not, should a persistent runner handle it?
3. If not, should we isolate the work into one or multiple subagents?

Design goals:
- stable before clever
- cheap to run
- explainable in production
- easy to improve with replay/eval feedback later

Output:
- system_preferred_route: initial route bias before main-brain hint merge
- route: compatibility alias for the same preferred route
"""

from __future__ import annotations

import argparse
import json
import re
from typing import Iterable

from octopus_config import load_octopus_config


RUNNER_PATTERNS = [
    r"\b(curl|grep|rg|tail|head|pwd|ls|find|cat|jq|sed|awk|ss|ps|top|netstat)\b",
    r"\b(log|logs|health|status|version|port|env|headers?|pid|process|uptime)\b",
    r"(日志|端口|版本|环境变量|连通性|健康检查|进程|服务状态|端口监听|磁盘|内存|cpu|负载)",
    r"(ログ|ポート|バージョン|環境変数|ヘルスチェック|プロセス|サービス状態|ディスク|メモリ|負荷)",
    r"(로그|포트|버전|환경 변수|헬스 체크|프로세스|서비스 상태|디스크|메모리|부하)",
    r"(registros?|logs?|puerto|versión|variables? de entorno|salud|proceso|estado del servicio|disco|memoria|carga)",
    r"(logs?|porta|versão|variáveis? de ambiente|saúde|processo|estado do serviço|disco|memória|carga)",
    r"(логи?|порт|версия|переменные окружения|здоровье|процесс|состояние сервиса|диск|память|нагрузка)",
]

RUNNER_READ_ONLY_INTENT_PATTERNS = [
    r"(看下|看一下|看看|查下|查一下|查看|搜一下|搜下|搜索|列出|显示|读取|有没有|确认一下|检查一下)",
    r"\b(check|inspect|show|list|display|read|search|find|look at|verify|confirm)\b",
    r"(見て|見せて|確認して|調べて|検索して|一覧|表示して|読んで|あるか)",
    r"(확인해|확인해줘|봐줘|보여줘|찾아줘|검색해|읽어줘|있는지)",
    r"(verifica|comprueba|muestra|lista|lee|busca|encuentra|revisa)",
    r"(verifique|confira|mostre|liste|leia|busque|encontre|revise)",
    r"(проверь|посмотри|покажи|список|прочитай|найди|поищи|убедись)",
]

RUNNER_TARGET_PATTERNS = [
    r"(日志|端口|进程|状态|文件|目录|环境变量|监听|路径|配置|版本|health|输出)",
    r"\b(log|logs|port|ports|process|pid|status|file|files|directory|directories|env|environment|path|config|version|health|output)\b",
    r"(ログ|ポート|プロセス|状態|ファイル|ディレクトリ|環境変数|パス|設定|バージョン|出力)",
    r"(로그|포트|프로세스|상태|파일|디렉터리|환경 변수|경로|설정|버전|출력)",
    r"(log|logs|puerto|proceso|estado|archivo|archivos|directorio|directorios|entorno|ruta|configuración|versión|salida)",
    r"(log|logs|porta|processo|estado|arquivo|arquivos|diretório|diretórios|ambiente|caminho|configuração|versão|saída)",
    r"(лог|логи|порт|процесс|состояние|файл|файлы|каталог|каталоги|окружение|путь|конфиг|версия|вывод)",
]

RUNNER_NEGATIVE_PATTERNS = [
    r"(修复|修改|改代码|改一下|重构|实现|开发|分析|对比|研究|方案|根因|原因|解释|总结|写文档|写一版|报告|周报|部署|重启|安装|卸载|删除|新增|创建|迁移|权限|密钥|数据库)",
    r"\b(fix|modify|change|patch|refactor|implement|develop|analy(?:ze|sis)|compare|research|proposal|root cause|cause|reason|explain|summary|summarize|write|report|deploy|restart|install|uninstall|delete|create|add|migrate|permission|secret|database)\b",
    r"(修正|変更|コードを変更|リファクタ|実装|開発|分析|比較|調査|提案|根本原因|説明|要約|文書|レポート|デプロイ|再起動|インストール|アンインストール|削除|追加|作成|移行|権限|シークレット|データベース)",
    r"(수정|변경|코드 수정|리팩터|구현|개발|분석|비교|조사|제안|근본 원인|설명|요약|문서|보고서|배포|재시작|설치|삭제|추가|생성|마이그레이션|권한|시크릿|데이터베이스)",
    r"(arregla|corrige|modifica|cambia|refactoriza|implementa|desarrolla|analiza|compara|investiga|propuesta|causa raíz|explica|resume|documenta|informe|despliega|reinicia|instala|desinstala|elimina|agrega|crea|migra|permisos|secreto|base de datos)",
    r"(corrija|conserte|modifique|mude|refatore|implemente|desenvolva|analise|compare|pesquise|proposta|causa raiz|explique|resuma|documente|relatório|implante|reinicie|instale|desinstale|exclua|adicione|crie|migre|permissão|segredo|banco de dados)",
    r"(исправь|почини|измени|модифицируй|рефактор|реализуй|разработай|проанализируй|сравни|исследуй|предложение|первопричина|объясни|суммируй|документ|отч[её]т|задеплой|перезапусти|установи|удали|добавь|создай|миграц|разрешени|секрет|база данных)",
]

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

CODE_PATTERNS = [
    r"(写代码|改代码|修改代码|修复|bug|重构|实现|开发|review|评审|测试|回归)",
    r"\b(code|coding|fix|bug|refactor|implement|patch|review|test|pytest|regression)\b",
    r"(コード|バグ|リファクタ|実装|レビュー|テスト|回帰)",
    r"(코드|버그|리팩터|구현|리뷰|테스트|회귀)",
    r"(código|bug|error|refactoriza|implementa|revisión|prueba|regresión)",
    r"(código|bug|erro|refatore|implemente|revisão|teste|regressão)",
    r"(код|баг|ошибк|рефактор|реализуй|ревью|тест|регресс)",
]

RESEARCH_PATTERNS = [
    r"(调研|对比|分析|研究|根因|方案|api|数据源|可行性)",
    r"\b(research|compare|analy|investigate|root cause|api|datasource|feasibility)\b",
    r"(調査|比較|分析|研究|根本原因|提案|実現可能性)",
    r"(조사|비교|분석|연구|근본 원인|제안|타당성)",
    r"(investiga|compara|analiza|investigación|causa raíz|factibilidad)",
    r"(pesquise|compare|analise|pesquisa|causa raiz|viabilidade)",
    r"(исследуй|сравни|проанализируй|анализ|первопричина|осуществимость)",
]

EXTERNAL_LOOKUP_PATTERNS = [
    r"(天气|花粉|汇率|航班|酒店|机票|新闻|价格|行情|官网|接口文档|文档链接)",
    r"\b(weather|pollen|exchange rate|flight|hotel|price|news|official docs?|documentation)\b",
]

WRITE_PATTERNS = [
    r"(文档|总结|报告|草稿|说明|翻译|写一篇)",
    r"\b(doc|docs|summary|report|draft|write|translate)\b",
    r"(ドキュメント|要約|レポート|下書き|説明|翻訳|書いて)",
    r"(문서|요약|보고서|초안|설명|번역|작성해)",
    r"(documento|resumen|informe|borrador|explicación|traducción|escribe)",
    r"(documento|resumo|relatório|rascunho|explicação|tradução|escreva)",
    r"(документ|сводк|отч[её]т|черновик|описание|перевод|напиши)",
]

SUMMARY_OUTPUT_PATTERNS = [
    r"(一句总结|三行总结|简短总结|简单总结|给我一句|给我三行|最后总结|最后给一句总结)",
    r"\b(one-line summary|three-line summary|brief summary|short summary)\b",
]

MULTI_STEP_PATTERNS = [
    r"(先.*再|然后|最后|并给出|顺便|同时需要|分别|先查.*再)",
    r"\b(first.*then|then|finally|also|and give|meanwhile|in parallel)\b",
]

PARALLEL_PATTERNS = [
    r"(并行|同时|分别处理|一边.*一边)",
    r"\b(parallel|simultaneous|separately)\b",
]

HIGH_RISK_PATTERNS = [
    r"(支付|认证|鉴权|登录|数据库|迁移|权限|安全)",
    r"((生产环境|线上环境|正式环境).*(发布|上线|变更)|(发布|上线).*(生产环境|线上环境|正式环境))",
    r"\b(payment|auth|authentication|login|database|migration|permission|security)\b",
    r"\b((prod|production)\s+(deploy|release|rollout|change)|release\s+to\s+(prod|production)|deploy\s+to\s+(prod|production)|production\s+release)\b",
    r"(本番環境|本番リリース|本番デプロイ|認証|権限|データベース|マイグレーション|セキュリティ|ログイン)",
    r"(운영 환경|프로덕션 릴리스|프로덕션 배포|인증|권한|데이터베이스|마이그레이션|보안|로그인)",
    r"(autenticación|permisos|base de datos|migración|seguridad|inicio de sesión|despliegue a producción|release a producción)",
    r"(autenticação|permissão|banco de dados|migração|segurança|login|deploy em produção|release em produção)",
    r"(продакшн|релиз в прод|деплой в прод|аутентификац|разрешени|база данных|миграц|безопасност|логин)",
]

SIMPLE_DIRECT_PATTERNS = [
    r"(是什么|什么意思|解释一下|简单说说|怎么理解)",
    r"\b(what is|explain|summarize|meaning)\b",
    r"(とは|意味|説明して|簡単に教えて)",
    r"(무엇|무슨 뜻|설명해줘|간단히 설명)",
    r"(qué es|qué significa|explica|resume)",
    r"(o que é|o que significa|explique|resuma)",
    r"(что такое|что значит|объясни|кратко опиши)",
]

LOCAL_STATE_PATTERNS = [
    r"(这台机器|本机|服务器|机器上|当前机器|当前环境|本地环境|系统状态)",
    r"\b(this machine|host|server|local env|current machine|system status)\b",
    r"(このマシン|このサーバー|ローカル環境|現在のマシン|システム状態)",
    r"(이 머신|이 서버|로컬 환경|현재 머신|시스템 상태)",
    r"(esta máquina|este servidor|entorno local|máquina actual|estado del sistema)",
    r"(esta máquina|este servidor|ambiente local|máquina atual|estado do sistema)",
    r"(эта машина|этот сервер|локальное окружение|текущая машина|состояние системы)",
]

VERIFY_PATTERNS = [
    r"(验证|确认|检查结果|回归|复现|复查|再看一下)",
    r"\b(verify|validation|regression|confirm|reproduce|double check)\b",
    r"(検証|確認|再確認|回帰|再現|もう一度見て)",
    r"(검증|확인|재확인|회귀|재현|다시 봐줘)",
    r"(verifica|validación|regresión|confirma|reproduce|revisa de nuevo)",
    r"(verifique|validação|regressão|confirme|reproduza|revise novamente)",
    r"(проверь|валидац|регресс|подтверди|воспроизведи|посмотри ещё раз)",
]

IMPLEMENT_PATTERNS = [
    r"(实现|落地|接入|修复|改一下|补上|生成代码|写脚本)",
    r"\b(implement|integrate|fix|patch|write code|script)\b",
    r"(実装|導入|統合|修正|補って|コードを書いて|スクリプトを書いて)",
    r"(구현|도입|통합|수정|보완|코드 작성|스크립트 작성)",
    r"(implementa|integra|corrige|parchea|escribe código|script)",
    r"(implemente|integre|corrija|patch|escreva código|script)",
    r"(реализуй|интегрируй|исправь|патч|напиши код|скрипт)",
]

MUTATION_PATTERNS = [
    r"(修改|改成|改为|更新|删除|新增|创建|写入|替换|迁移|重启|部署|安装|卸载|启用|禁用|调整)",
    r"(改cron|改配置|改任务|改脚本|改服务|更新配置|修改配置|修改任务|修改服务)",
    r"(触发并回读|更新并验证|改后验证|修后验证|重启并验证)",
    r"\b(modify|change|update|delete|add|create|replace|migrate|restart|deploy|install|uninstall|enable|disable|tune)\b",
    r"\b(update cron|change cron|modify cron|update config|modify config|change config|update service|modify service)\b",
    r"(変更|更新|削除|追加|作成|書き込み|置換|移行|再起動|デプロイ|インストール|有効化|無効化|調整)",
    r"(변경|업데이트|삭제|추가|생성|교체|마이그레이션|재시작|배포|설치|활성화|비활성화|조정)",
    r"(modifica|cambia|actualiza|elimina|agrega|crea|reemplaza|migra|reinicia|despliega|instala|desinstala|habilita|deshabilita|ajusta)",
    r"(modifique|mude|atualize|exclua|adicione|crie|substitua|migre|reinicie|implante|instale|desinstale|habilite|desabilite|ajuste)",
    r"(измени|обнови|удали|добавь|создай|замени|мигрируй|перезапусти|задеплой|установи|включи|выключи|настрой)",
]

COST_SENSITIVE_PATTERNS = [
    r"(省钱|低成本|便宜点|别太贵)",
    r"\b(cost|cheap|budget|save money)\b",
]

SEMANTIC_AMBIGUITY_PATTERNS = [
    r"(顺手|顺便|一起|同时帮我|看看要不要|必要时|如果需要|最好|更稳的方案)",
    r"\b(if needed|if necessary|also help|at the same time|better approach|safer approach)\b",
]

CONTINUATION_PATTERNS = [
    r"(继续|接着|下一步|再查一下|再看一下|再确认一下|顺手补|顺手加|补一下|补个测试|继续处理|继续推进)",
    r"\b(continue|follow[- ]?up|next step|check again|look again|verify again|add tests|follow through)\b",
    r"(続けて|次のステップ|もう一度見て|もう一度確認|テストを追加|続けて進めて)",
    r"(계속|다음 단계|다시 확인|다시 봐줘|테스트 추가|계속 진행)",
    r"(continúa|siguiente paso|revisa de nuevo|verifica de nuevo|agrega pruebas|sigue)",
    r"(continue|próximo passo|verifique novamente|revise novamente|adicione testes|siga)",
    r"(продолжай|следующий шаг|проверь ещё раз|посмотри ещё раз|добавь тесты|продолжи)",
]

REMOTE_TARGET_PATTERNS = [
    r"(远程|另一台机器|另一台主机|另一台机子|目标机器|目标主机|远端)",
    r"\b(remote|another host|another machine|target host|remote host)\b",
    r"(macmini|mac mini)",
    r"(リモート|別のマシン|別のホスト|対象ホスト)",
    r"(원격|다른 머신|다른 호스트|대상 호스트)",
    r"(remoto|otra máquina|otro host|host de destino)",
    r"(remoto|outra máquina|outro host|host de destino)",
    r"(удал[её]нн|другая машина|другой хост|целевой хост)",
]


def count_matches(text: str, patterns: Iterable[str]) -> int:
    return sum(1 for pattern in patterns if re.search(pattern, text, re.IGNORECASE))


def command_looks_read_only(command: str) -> bool:
    cmd = (command or "").strip()
    if not cmd:
        return False
    if any(re.search(pattern, cmd, re.IGNORECASE) for pattern in WRITE_COMMAND_PATTERNS):
        return False
    return any(re.search(pattern, cmd, re.IGNORECASE) for pattern in READ_ONLY_COMMAND_PATTERNS)


def extract_features(task: str, command: str = "") -> dict:
    raw_task = (task or "").strip()
    text = raw_task.lower()
    command = (command or "").strip()

    runner_hits = count_matches(text, RUNNER_PATTERNS)
    code_hits = count_matches(text, CODE_PATTERNS)
    research_hits = count_matches(text, RESEARCH_PATTERNS)
    external_lookup_hits = count_matches(text, EXTERNAL_LOOKUP_PATTERNS)
    write_hits = count_matches(text, WRITE_PATTERNS)
    summary_output_hits = count_matches(text, SUMMARY_OUTPUT_PATTERNS)
    multi_step_hits = count_matches(text, MULTI_STEP_PATTERNS)
    parallel_hits = count_matches(text, PARALLEL_PATTERNS)
    high_risk_hits = count_matches(text, HIGH_RISK_PATTERNS)
    simple_hits = count_matches(text, SIMPLE_DIRECT_PATTERNS)
    local_state_hits = count_matches(text, LOCAL_STATE_PATTERNS)
    verify_hits = count_matches(text, VERIFY_PATTERNS)
    implement_hits = count_matches(text, IMPLEMENT_PATTERNS)
    mutation_hits = count_matches(text, MUTATION_PATTERNS)
    cost_sensitive_hits = count_matches(text, COST_SENSITIVE_PATTERNS)
    semantic_ambiguity_hits = count_matches(text, SEMANTIC_AMBIGUITY_PATTERNS)
    continuation_hits = count_matches(text, CONTINUATION_PATTERNS)
    remote_target_hits = count_matches(text, REMOTE_TARGET_PATTERNS)
    runner_read_only_intent_hits = count_matches(text, RUNNER_READ_ONLY_INTENT_PATTERNS)
    runner_target_hits = count_matches(text, RUNNER_TARGET_PATTERNS)
    runner_negative_hits = count_matches(text, RUNNER_NEGATIVE_PATTERNS)
    command_read_only = command_looks_read_only(command)
    effective_write_hits = write_hits
    if summary_output_hits > 0 and code_hits == 0 and research_hits == 0 and mutation_hits == 0:
        effective_write_hits = 0

    estimated_steps = 1
    if multi_step_hits > 0:
        estimated_steps += 1
    if research_hits > 0:
        estimated_steps += 1
    if code_hits > 0:
        estimated_steps += 1
    if write_hits > 0:
        estimated_steps += 1
    if parallel_hits > 0:
        estimated_steps += 1
    if verify_hits > 0:
        estimated_steps += 1
    if mutation_hits > 0:
        estimated_steps += 1
    if len(raw_task) > 140:
        estimated_steps += 1

    task_shape = "single_step"
    if estimated_steps >= 4 or parallel_hits > 0:
        task_shape = "staged"
    elif estimated_steps >= 2:
        task_shape = "multi_step"

    context_growth = "low"
    if code_hits > 0 or local_state_hits > 0 or verify_hits > 0 or mutation_hits > 0:
        context_growth = "medium"
    if estimated_steps >= 4 or mutation_hits > 0 or (research_hits > 0 and (code_hits > 0 or write_hits > 0)):
        context_growth = "high"

    latency_sensitivity = "normal"
    if local_state_hits > 0 or command:
        latency_sensitivity = "high"
    elif external_lookup_hits > 0 and research_hits == 0 and code_hits == 0:
        latency_sensitivity = "normal"

    features = {
        "task_length": len(raw_task),
        "has_command": bool(command),
        "command_read_only": command_read_only,
        "runner_hits": runner_hits,
        "runner_read_only_intent_hits": runner_read_only_intent_hits,
        "runner_target_hits": runner_target_hits,
        "runner_negative_hits": runner_negative_hits,
        "code_hits": code_hits,
        "research_hits": research_hits,
        "external_lookup_hits": external_lookup_hits,
        "write_hits": write_hits,
        "summary_output_hits": summary_output_hits,
        "multi_step_hits": multi_step_hits,
        "parallel_hits": parallel_hits,
        "high_risk_hits": high_risk_hits,
        "simple_hits": simple_hits,
        "local_state_hits": local_state_hits,
        "verify_hits": verify_hits,
        "implement_hits": implement_hits,
        "mutation_hits": mutation_hits,
        "cost_sensitive_hits": cost_sensitive_hits,
        "semantic_ambiguity_hits": semantic_ambiguity_hits,
        "continuation_hits": continuation_hits,
        "remote_target_hits": remote_target_hits,
        "requires_tools": bool(command) or runner_hits > 0 or local_state_hits > 0 or remote_target_hits > 0,
        "requires_code_work": code_hits > 0,
        "requires_research": research_hits > 0,
        "requires_mutation": mutation_hits > 0 or (implement_hits > 0 and (code_hits > 0 or local_state_hits > 0)),
        "external_lookup_only": external_lookup_hits > 0 and research_hits == 0 and code_hits == 0 and write_hits == 0,
        "requires_writing": effective_write_hits > 0,
        "estimated_steps": estimated_steps,
        "task_shape": task_shape,
        "multi_step": estimated_steps >= 2,
        "parallelizable": (
            parallel_hits > 0
            or (research_hits > 0 and write_hits > 0 and multi_step_hits > 0)
            or (verify_hits > 0 and (code_hits > 0 or implement_hits > 0))
        ),
        "tool_observation_only": (
            (bool(command) or runner_hits > 0 or local_state_hits > 0 or remote_target_hits > 0)
            and mutation_hits == 0
            and implement_hits == 0
            and code_hits == 0
            and research_hits == 0
            and effective_write_hits == 0
        ),
        "target_scope": "remote" if remote_target_hits > 0 else ("local" if local_state_hits > 0 else "generic"),
        "high_risk": high_risk_hits > 0,
        "followup_candidate": continuation_hits > 0,
        "context_growth": context_growth,
        "latency_sensitivity": latency_sensitivity,
        "simple_direct_candidate": simple_hits > 0 and runner_hits == 0 and code_hits == 0 and research_hits == 0 and local_state_hits == 0,
    }
    features["hard_runner_candidate"] = bool(
        runner_negative_hits == 0
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
            command_read_only
            or (
                runner_read_only_intent_hits > 0
                and (runner_target_hits > 0 or runner_hits > 0 or local_state_hits > 0 or remote_target_hits > 0)
            )
            or (
                features["tool_observation_only"]
                and runner_target_hits > 0
                and (runner_read_only_intent_hits > 0 or runner_hits > 0 or local_state_hits > 0)
            )
        )
    )
    return features


def infer_role_hint(features: dict) -> str:
    if features["tool_observation_only"]:
        return "octopus-runner"
    if features["requires_mutation"] and not features["requires_research"]:
        return "octopus-fix"
    if features["requires_code_work"]:
        return "octopus-fix"
    if features["requires_writing"] and not features["requires_research"]:
        return "octopus-writer"
    if features["requires_research"] and not features["requires_code_work"]:
        return "octopus-scout"
    if features["high_risk"]:
        return "octopus-analyze"
    return "octopus-power"


def infer_tier_hint(features: dict, route: str) -> str:
    if route == "runner":
        return "trivial"
    if route == "direct":
        return "simple"
    if features["high_risk"] or route == "spawn_multi":
        return "hard"
    if features["requires_code_work"] or features["requires_research"] or features["estimated_steps"] >= 3:
        return "normal"
    return "simple"


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


def choose_semantic_model_hint() -> str:
    try:
        from octopus_config import MODEL_POLICY_FILE, load_json  # lazy import to keep route script cheap

        policy = load_json(MODEL_POLICY_FILE)
        if isinstance(policy, dict):
            labels = policy.get("labels", {})
            if isinstance(labels, dict):
                model_id = str(labels.get("octopus-router", "") or labels.get("octopus-runner", "") or "")
                if model_id:
                    return model_id
    except Exception:
        pass
    return "minimax-portal/MiniMax-M2.7-highspeed"


def should_request_semantic_review(features: dict, scores: dict, route: str) -> tuple[bool, float, str]:
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

    if features["semantic_ambiguity_hits"] > 0 and margin < 0.55:
        return True, margin, "ambiguous_task_shape"

    if features["requires_research"] and features["requires_tools"] and margin < 0.6:
        return True, margin, "research_with_tools"

    if features["estimated_steps"] >= 3 and top_route != second_route and margin < 0.45:
        return True, margin, "close_score_multi_step"

    return False, margin, ""


def hard_gate_route(features: dict) -> tuple[str | None, list[str]]:
    reasons: list[str] = []
    runtime_cfg = load_octopus_config().get("runtime_policy", {})
    switches = runtime_cfg.get("switches", {}) if isinstance(runtime_cfg, dict) else {}
    if not bool(switches.get("hard_runner_only", True)):
        return None, reasons

    if features.get("hard_runner_candidate"):
        reasons.append("hard_runner_only")
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
    features = extract_features(task, command)

    direct_score = 0.0
    runner_score = 0.0
    spawn_single_score = 0.0
    spawn_multi_score = 0.0
    reason_codes: list[str] = []

    hard_route, hard_reasons = hard_gate_route(features)
    if hard_route:
        route = hard_route
        scores = {"direct": 0.0, "runner": 0.0, "spawn_single": 0.0, "spawn_multi": 0.0}
        scores[route] = 1.0
        reason_codes.extend(hard_reasons)
    else:
        if features["simple_direct_candidate"]:
            direct_score += 0.9
            reason_codes.append("simple_direct_candidate")

        if not features["requires_tools"] and features["task_length"] <= 120 and features["estimated_steps"] <= 2:
            direct_score += 0.6
            reason_codes.append("small_context_task")

        if features["external_lookup_only"] and features["estimated_steps"] <= 2:
            direct_score += 0.5
            reason_codes.append("single_round_lookup")

        if features["requires_tools"]:
            runner_score += 0.7
            spawn_single_score += 0.15
            reason_codes.append("tool_needed")

        if features["requires_tools"] and (
            features["runner_negative_hits"] > 0
            or features["simple_hits"] > 0
            or features["summary_output_hits"] > 0
            or features["requires_writing"]
        ):
            runner_score -= 0.55
            spawn_single_score += 0.45
            reason_codes.append("tool_plus_reasoning_or_writing")

        if features["requires_mutation"]:
            runner_score -= 0.8
            spawn_single_score += 1.15
            spawn_multi_score += 0.1
            reason_codes.append("mutation_work")

        if features["local_state_hits"] > 0:
            runner_score += 0.8
            reason_codes.append("local_state_inspection")

        if features["requires_code_work"]:
            spawn_single_score += 1.0
            reason_codes.append("code_work")

        if features["requires_research"]:
            spawn_single_score += 0.7
            reason_codes.append("research_work")

        if features["requires_writing"]:
            spawn_single_score += 0.3
            reason_codes.append("writing_work")

        if features["multi_step"]:
            spawn_single_score += 0.55
            reason_codes.append("multi_step")

        if features["parallelizable"]:
            spawn_multi_score += 0.95
            reason_codes.append("parallelizable")

        if features["parallelizable"] and features["estimated_steps"] >= 3:
            spawn_multi_score += 0.8
            reason_codes.append("parallelizable_staged_work")

        if features["high_risk"]:
            spawn_single_score += 0.65
            spawn_multi_score += 0.35
            reason_codes.append("high_risk")

        if features["verify_hits"] > 0 and (features["requires_code_work"] or features["requires_research"]):
            spawn_multi_score += 0.45
            reason_codes.append("verification_after_work")

        if features["requires_tools"] and (features["requires_code_work"] or features["requires_research"]):
            runner_score -= 0.4
            spawn_single_score += 0.4
            reason_codes.append("tool_plus_reasoning")

        if features["local_state_hits"] > 0 and features["requires_mutation"]:
            runner_score -= 0.6
            spawn_single_score += 0.45
            reason_codes.append("local_change_not_runner")

        if features["cost_sensitive_hits"] > 0 and features["requires_tools"] and not features["requires_code_work"]:
            runner_score += 0.1
            reason_codes.append("cost_sensitive_fast_path")

        scores = {
            "direct": round(direct_score, 3),
            "runner": round(runner_score, 3),
            "spawn_single": round(spawn_single_score, 3),
            "spawn_multi": round(spawn_multi_score, 3),
        }

        route = max(scores, key=scores.get)
        confidence = round(min(1.0, max(scores.values()) / 2.0), 3)

        if route == "direct" and scores["spawn_single"] >= 0.9:
            route = "spawn_single"
            reason_codes.append("prefer_stability_over_ambiguous_direct")
        elif route == "runner" and scores["spawn_single"] >= 0.95 and features["requires_research"]:
            route = "spawn_single"
            reason_codes.append("prefer_research_isolation_over_runner")
    if hard_route:
        confidence = 0.92 if route in ("runner", "direct") else 0.88

    needs_semantic_review, score_margin, semantic_reason = should_request_semantic_review(features, scores, route)
    semantic_model_hint = choose_semantic_model_hint() if needs_semantic_review else ""

    role_hint = infer_role_hint(features)
    if route == "direct":
        role_hint = "main"
    elif route == "runner":
        role_hint = "octopus-runner"
    elif route == "spawn_multi":
        role_hint = "octopus-power"

    tier_hint = infer_tier_hint(features, route)
    should_wait = route == "runner"
    wait_timeout_seconds = 0
    if route == "runner":
        wait_timeout_seconds = 8 if features["estimated_steps"] <= 2 else 12

    return {
        "system_preferred_route": route,
        "route": route,
        "confidence": confidence,
        "reason": reason_codes[0] if reason_codes else "default_route",
        "reasons": reason_codes,
        "reason_codes": reason_codes,
        "scores": scores,
        "features": features,
        "task_class": infer_task_class(features, route),
        "role_hint": role_hint,
        "tier_hint": tier_hint,
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
