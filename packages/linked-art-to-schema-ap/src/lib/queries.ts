/**
 * SPARQL queries that project Linked Art (CIDOC-CRM) into the SCHEMA-AP-NDE
 * pivot. The selector enumerates the objects to map; each CONSTRUCT maps one
 * target class. Keeping one CONSTRUCT per class (rather than one mega-query)
 * lets the pipeline run them as separate executors – the same structure the
 * EDM export pipeline uses.
 *
 * Per-class CONSTRUCTs use `UNION` (one branch per multi-valued property)
 * rather than `OPTIONAL`, so that multi-valued properties do not multiply
 * into cross-product duplicates.
 */

/** Namespaces shared by the selector and the CONSTRUCT mappings. */
const PREFIXES = `
PREFIX crm: <http://www.cidoc-crm.org/cidoc-crm/>
PREFIX la: <https://linked.art/ns/terms/>
PREFIX schema: <https://schema.org/>
`;

/**
 * Selects the Linked Art objects to project. Each result IRI is injected into
 * the CONSTRUCT executors as a `VALUES ?this { ... }` clause, so the CONSTRUCTs
 * map one object at a time.
 */
export const SELECT_HUMAN_MADE_OBJECTS = `${PREFIXES}
SELECT ?this WHERE {
  ?this a crm:E22_Human-Made_Object .
}`;

/**
 * Maps a Linked Art `crm:E22_Human-Made_Object` to a SCHEMA-AP-NDE
 * `schema:CreativeWork`.
 *
 * Starter subset – covers name, classification, creator, creation date and
 * representation. It does NOT yet emit every SCHEMA-AP-NDE property; notably
 * the `schema:sdDatePublished` and `schema:isPartOf` metadata-record fields
 * are record-level, not derivable from the object graph alone, and
 * `schema:name` is emitted as the raw `crm:P190_has_symbolic_content` string
 * without deriving the language tag from `crm:P72_has_language`. The mapping is
 * lossy by design – CIDOC-CRM’s event-based structure flattens into schema.org
 * – and the validation stage reports where the projection falls short of the
 * SCHEMA-AP-NDE shapes.
 */
export const CONSTRUCT_CREATIVE_WORK = `${PREFIXES}
CONSTRUCT {
  ?this a schema:CreativeWork ;
    schema:name ?name ;
    schema:sdDatePublished ?now ;
    schema:associatedMedia ?media ; 
    schema:additionalType ?type ;
    schema:creator ?creator ;
    schema:dateCreated ?created ;
    schema:image ?image ;
    
    
}
WHERE {
  {
    ?this crm:P1_is_identified_by ?appellation .
    ?appellation a crm:E33_E41_Linguistic_Appellation ;
      crm:P190_has_symbolic_content ?name .
  } UNION {
    ?this crm:P2_has_type ?type .
  } UNION {
    ?this crm:P108i_was_produced_by ?production .
    ?production crm:P14_carried_out_by ?creator .
  } UNION {
    ?this crm:P108i_was_produced_by ?production .
    ?production crm:P4_has_time-span ?timespan .
    ?timespan crm:P82a_begin_of_the_begin ?created .
  } UNION {
    ?this crm:P138i_has_representation ?image .
  }
}`;

/** All CONSTRUCT mappings, one per target class. */
export const MAPPING_QUERIES = [CONSTRUCT_CREATIVE_WORK];
