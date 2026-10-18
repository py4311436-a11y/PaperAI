# Rust provider integration suite (against local Mock SSE)

Generated: 2026-10-18T12:19:09.052Z
Runner: scripts/run-ai-rust-tests.mjs

| Test | Mock scenario | Result | Requests seen by mock |
|---|---|---|---|
| happy_path_streams_and_completes | happy | **PASS** | 1 |
| batched_events_in_one_packet | batched | **PASS** | 1 |
| utf8_split_across_chunks_is_not_corrupted | splitUtf8 | **PASS** | 1 |
| crlf_and_comment_lines | crlfAndComments | **PASS** | 1 |
| empty_choices_and_usage_only_tail_do_not_error | emptyThenUsage | **PASS** | 1 |
| missing_done_is_a_success_when_content_arrived | noDone | **PASS** | 1 |
| abrupt_close_without_content_is_an_error_not_a_silent_success | abruptEmpty | **PASS** | 1 |
| in_stream_error_object_terminates_with_error | midStreamError | **PASS** | 1 |
| non_sse_200_is_reported_as_bad_stream | notSse | **PASS** | 1 |
| http_401_maps_to_unauthorized | unauthorized | **PASS** | 1 |
| http_403_maps_to_unauthorized | forbidden | **PASS** | 1 |
| http_404_maps_to_not_found_with_a_url_hint | modelNotFound | **PASS** | 1 |
| http_429_maps_to_rate_limited | rateLimited | **PASS** | 1 |
| http_500_maps_to_provider_error | serverError | **PASS** | 1 |
| http_400_maps_to_bad_config | badRequest | **PASS** | 1 |
| redirect_is_not_followed | redirect | **PASS** | 1 |
| missing_key_fails_before_any_network_call | happy | **PASS** | 0 |
| plain_http_to_a_remote_host_is_refused | happy | **PASS** | 0 |
| cancel_stops_the_stream_promptly | slow | **PASS** | 1 |
| a_long_stream_is_not_truncated_mid_answer | longHealthy | **PASS** | 1 |
| a_stream_that_stops_mid_answer_is_reported_as_interrupted | stallAfterContent | **PASS** | 1 |
| a_collected_answer_contains_every_delta | slow | **PASS** | 1 |
| a_collected_answer_is_empty_when_nothing_arrives | abruptEmpty | **PASS** | 1 |
| context_is_sent_verbatim_and_nothing_else | happy | **PASS** | 1 |
| opencode_profiles_send_the_session_header | happy | **PASS** | 1 |
| ordinary_profiles_do_not_send_the_session_header | happy | **PASS** | 1 |
| the_session_header_value_is_the_conversation_id | happy | **PASS** | 0 |
| the_notes_pipeline_uses_its_own_session_scope | happy | **PASS** | 0 |
| a_model_catalogue_request_carries_no_session_header | happy | **PASS** | 1 |
| cargo test --lib (unit layer) | — | **PASS** | 0 |

**30/30 PASS**

The mock redacts `Authorization` before recording, so
`rust-provider-requests.json` is safe to archive as evidence.
