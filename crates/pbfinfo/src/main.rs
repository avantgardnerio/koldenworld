// Prints what an OSM PBF file says about itself, and whether its ways carry their own node coordinates
// (the optional "LocationsOnWays" lat/lon fields), which would let way geometry be built without a node join.
//   pbfinfo <file.osm.pbf>
use osmpbf::{BlobDecode, BlobReader, Element};

fn main() {
    let path = std::env::args()
        .nth(1)
        .expect("usage: pbfinfo <file.osm.pbf>");
    let mut blobs = [0u64; 3];
    let (mut ways, mut refs, mut located) = (0u64, 0u64, 0u64);

    for blob in BlobReader::from_path(&path).expect("open") {
        match blob.expect("read blob").decode().expect("decode blob") {
            BlobDecode::OsmHeader(header) => {
                println!(
                    "writing program: {}",
                    header.writing_program().unwrap_or("?")
                );
                println!("required features: {:?}", header.required_features());
                println!("optional features: {:?}", header.optional_features());
            }
            BlobDecode::OsmData(block) => {
                let kind = block_kind(&block);
                blobs[kind] += 1;
                if kind == 1 {
                    block.for_each_element(|element| {
                        if let Element::Way(way) = element {
                            ways += 1;
                            refs += way.refs().len() as u64;
                            located += way.node_locations().len() as u64;
                        }
                    });
                }
            }
            BlobDecode::Unknown(name) => println!("unknown blob: {name}"),
        }
    }

    println!(
        "blobs: {} nodes, {} ways, {} relations",
        blobs[0], blobs[1], blobs[2]
    );
    println!("ways: {ways}, node refs: {refs}, refs with a location: {located}");
}

/// 0 nodes, 1 ways, 2 relations: what the block's first group holds. Sorted files keep one kind per block.
fn block_kind(block: &osmpbf::PrimitiveBlock) -> usize {
    let group = block.groups().next().expect("block with no groups");
    if group.ways().next().is_some() {
        1
    } else if group.relations().next().is_some() {
        2
    } else {
        0
    }
}
