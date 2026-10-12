import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const repoRoot = dirname(fileURLToPath(import.meta.url));
const xpiName = "academic-lens.xpi";
const outputPath1 = join(repoRoot, xpiName);
const outputPath2 = join(dirname(repoRoot), xpiName);

// CRC-32 Table
const crcTable = new Uint32Array(256);
for (let i = 0; i < crcTable.length; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    crcTable[i] = c >>> 0;
}

function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) {
        crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
    const year = Math.max(date.getFullYear(), 1980);
    const month = date.getMonth() + 1;
    const day = date.getDate();
    const hours = date.getHours();
    const minutes = date.getMinutes();
    const seconds = Math.floor(date.getSeconds() / 2);

    return {
        date: ((year - 1980) << 9) | (month << 5) | day,
        time: (hours << 11) | (minutes << 5) | seconds,
    };
}

async function collectFiles(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = [];

    for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        const rel = relative(repoRoot, fullPath).replace(/\\/g, "/");

        // Skip build outputs, git, node_modules, and markdown docs
        if (
            entry.name.startsWith(".") ||
            entry.name === "node_modules" ||
            entry.name.endsWith(".xpi") ||
            entry.name === "build.mjs" ||
            entry.name === "package.json" ||
            entry.name === "README.md"
        ) {
            continue;
        }

        if (entry.isDirectory()) {
            files.push(...(await collectFiles(fullPath)));
        } else if (entry.isFile()) {
            files.push(fullPath);
        }
    }

    return files.sort();
}

async function packXpi() {
    console.log("Packing Academic Lens Zotero addon (.xpi)...");
    const filePaths = await collectFiles(repoRoot);
    const entries = [];
    let localOffset = 0;
    const localChunks = [];

    for (const filePath of filePaths) {
        const relPath = relative(repoRoot, filePath).replace(/\\/g, "/");
        const raw = await readFile(filePath);
        const fileStat = await stat(filePath);
        const { date, time } = dosDateTime(fileStat.mtime);
        const crc = crc32(raw);

        const deflated = deflateRawSync(raw);
        const useDeflate = deflated.length < raw.length;
        const method = useDeflate ? 8 : 0;
        const body = useDeflate ? deflated : raw;
        const compressedSize = body.length;
        const size = raw.length;
        const nameBytes = Buffer.from(relPath, "utf8");

        const header = Buffer.alloc(30);
        header.writeUInt32LE(0x04034b50, 0); // Local file header signature
        header.writeUInt16LE(20, 4);         // Version needed
        header.writeUInt16LE(0, 6);          // General purpose bit flag
        header.writeUInt16LE(method, 8);     // Compression method
        header.writeUInt16LE(time, 10);
        header.writeUInt16LE(date, 12);
        header.writeUInt32LE(crc, 14);
        header.writeUInt32LE(compressedSize, 18);
        header.writeUInt32LE(size, 22);
        header.writeUInt16LE(nameBytes.length, 26);
        header.writeUInt16LE(0, 28);         // Extra field length

        localChunks.push(header, nameBytes, body);

        entries.push({
            name: nameBytes,
            method,
            time,
            date,
            crc,
            compressedSize,
            size,
            offset: localOffset,
        });

        localOffset += header.length + nameBytes.length + body.length;
        console.log(`  + ${relPath} (${size} bytes)`);
    }

    const centralChunks = [];
    let centralSize = 0;

    for (const entry of entries) {
        const header = Buffer.alloc(46);
        header.writeUInt32LE(0x02014b50, 0); // Central directory file header
        header.writeUInt16LE(20, 4);         // Version made by
        header.writeUInt16LE(20, 6);         // Version needed
        header.writeUInt16LE(0, 8);          // General purpose bit flag
        header.writeUInt16LE(entry.method, 10);
        header.writeUInt16LE(entry.time, 12);
        header.writeUInt16LE(entry.date, 14);
        header.writeUInt32LE(entry.crc, 16);
        header.writeUInt32LE(entry.compressedSize, 20);
        header.writeUInt32LE(entry.size, 24);
        header.writeUInt16LE(entry.name.length, 28);
        header.writeUInt16LE(0, 30);         // Extra field length
        header.writeUInt16LE(0, 32);         // File comment length
        header.writeUInt16LE(0, 34);         // Disk number start
        header.writeUInt16LE(0, 36);         // Internal file attributes
        header.writeUInt32LE(0, 38);         // External file attributes
        header.writeUInt32LE(entry.offset, 42);

        centralChunks.push(header, entry.name);
        centralSize += header.length + entry.name.length;
    }

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);       // End of central directory signature
    eocd.writeUInt16LE(0, 4);                // Number of this disk
    eocd.writeUInt16LE(0, 6);                // Disk where central directory starts
    eocd.writeUInt16LE(entries.length, 8);   // Number of central directory records on this disk
    eocd.writeUInt16LE(entries.length, 10);  // Total number of central directory records
    eocd.writeUInt32LE(centralSize, 12);     // Size of central directory
    eocd.writeUInt32LE(localOffset, 16);     // Offset of start of central directory
    eocd.writeUInt16LE(0, 20);               // Comment length

    const finalBuffer = Buffer.concat([...localChunks, ...centralChunks, eocd]);
    await writeFile(outputPath1, finalBuffer);
    await writeFile(outputPath2, finalBuffer);

    console.log(`\nSuccessfully built:`);
    console.log(`  -> ${outputPath1} (${finalBuffer.length} bytes)`);
    console.log(`  -> ${outputPath2} (${finalBuffer.length} bytes)`);
}

packXpi().catch((err) => {
    console.error("Pack failed:", err);
    process.exit(1);
});
