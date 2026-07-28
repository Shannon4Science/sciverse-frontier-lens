from app.assembly import assemble_paper_graph


def test_entity_provenance_is_sanitized_into_source_anchors() -> None:
    graph = assemble_paper_graph(
        {"schema_id": "paper-1", "title": "A paper"},
        [
            {
                "entity_id": "entity-1",
                "entity_type": "Component",
                "name": "Attention",
                "raw_path": "must-not-leak",
                "provenance": [
                    {"paragraph_id": "paragraph-4", "marker_num": 4},
                    {"marker": "§7", "raw_path": "must-not-leak"},
                    "§9",
                    "invalid",
                    {"marker_num": 4, "paragraph_id": "paragraph-4"},
                ],
            }
        ],
        [],
        entities_truncated=False,
        relations_truncated=False,
    )

    entity = graph.nodes[1]
    assert [anchor.model_dump() for anchor in entity.anchors] == [
        {"paragraph_id": "paragraph-4", "marker_num": 4},
        {"paragraph_id": None, "marker_num": 7},
        {"paragraph_id": None, "marker_num": 9},
    ]
    payload = graph.model_dump_json()
    assert "raw_path" not in payload
    assert "must-not-leak" not in payload


def test_entity_without_valid_provenance_has_no_anchor() -> None:
    graph = assemble_paper_graph(
        {"schema_id": "paper-1", "title": "A paper"},
        [
            {
                "entity_id": "entity-1",
                "entity_type": "Finding",
                "name": "Result",
                "provenance": [{}, None, "appendix"],
            }
        ],
        [],
        entities_truncated=False,
        relations_truncated=False,
    )

    assert graph.nodes[1].anchors == []
