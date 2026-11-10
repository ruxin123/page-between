import SwiftUI
import UniformTypeIdentifiers
import ReadiumZIPFoundation

actor MobileBackupArchive {
    static let shared = MobileBackupArchive()
    private var working = false
    static let frequencyKey = "mobile.backup.frequency"
    static var directory: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("PageBetweenBackups", isDirectory: true)
    }
    static func list() throws -> [URL] {
        guard FileManager.default.fileExists(atPath: directory.path) else { return [] }
        return try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.creationDateKey])
            .filter { $0.pathExtension == "pbmobilebackup" }.sorted { $0.lastPathComponent > $1.lastPathComponent }
    }
    func create(_ repository: LibraryRepository, automatic: Bool = false) async throws -> URL {
        guard !working else { throw ServiceError.message("备份正在进行。") }
        working = true; defer { working = false }
        let manager = FileManager.default
        try manager.createDirectory(at: Self.directory, withIntermediateDirectories: true)
        let folder = manager.temporaryDirectory.appendingPathComponent("backup-" + UUID().uuidString)
        try manager.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? manager.removeItem(at: folder) }
        let manifest = try await repository.backupSnapshot(to: folder)
        let formatter = DateFormatter(); formatter.dateFormat = "yyyyMMdd-HHmmss"; formatter.locale = Locale(identifier: "en_US_POSIX")
        let name = formatter.string(from: Date()) + "-" + (automatic ? "auto-" : "") + UUID().uuidString + ".pbmobilebackup"
        let target = Self.directory.appendingPathComponent(name), partial = folder.appendingPathComponent("backup.zip")
        let archive = try await Archive(url: partial, accessMode: .create)
        for item in manifest.files { try await archive.addEntry(with: item.path, fileURL: folder.appendingPathComponent(item.path), compressionMethod: .deflate) }
        let meta = folder.appendingPathComponent("manifest.json")
        try JSONEncoder().encode(manifest).write(to: meta, options: .atomic)
        try await archive.addEntry(with: "manifest.json", fileURL: meta, compressionMethod: .deflate)
        try manager.moveItem(at: partial, to: target)
        if automatic {
            for old in try Self.list().filter({ $0.lastPathComponent.contains("-auto-") }).dropFirst(3) { try? manager.removeItem(at: old) }
            UserDefaults.standard.set(Date(), forKey: "mobile.backup.lastAutomatic")
        }
        return target
    }
    func restore(_ url: URL, repository: LibraryRepository) async throws {
        guard !working else { throw ServiceError.message("备份正在进行。") }
        working = true; defer { working = false }
        let access = url.startAccessingSecurityScopedResource(); defer { if access { url.stopAccessingSecurityScopedResource() } }
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("restore-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let archive = try await Archive(url: url, accessMode: .read), entries = try await archive.entries()
        guard entries.count <= 100001, Set(entries.map(\.path)).count == entries.count,
              let meta = entries.first(where: { $0.path == "manifest.json" }), meta.type == .file,
              meta.uncompressedSize <= 32 * 1024 * 1024 else { throw LibraryFailure.invalidFile }
        let file = folder.appendingPathComponent("manifest.json")
        guard try await archive.extract(meta, to: file) == meta.checksum else { throw LibraryFailure.invalidFile }
        let manifest = try JSONDecoder().decode(MobileBackupManifest.self, from: Data(contentsOf: file)); try manifest.validate()
        guard Set(entries.map(\.path)) == Set(["manifest.json"] + manifest.files.map(\.path)) else { throw LibraryFailure.invalidFile }
        let indexed = Dictionary(uniqueKeysWithValues: entries.map { ($0.path, $0) })
        for item in manifest.files {
            guard let entry = indexed[item.path], entry.type == .file, entry.uncompressedSize == item.size else { throw LibraryFailure.invalidFile }
            let target = folder.appendingPathComponent(item.path)
            try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
            guard try await archive.extract(entry, to: target) == entry.checksum else { throw LibraryFailure.invalidFile }
        }
        try await repository.restoreBackup(manifest, from: folder)
    }
    @MainActor static func automatic(_ store: LibraryStore) async {
        let frequency = UserDefaults.standard.string(forKey: frequencyKey) ?? "off"
        guard ["daily", "weekly"].contains(frequency), !store.importing, !store.preparation.hasActiveWork, !store.books.isEmpty else { return }
        let last = UserDefaults.standard.object(forKey: "mobile.backup.lastAutomatic") as? Date ?? .distantPast
        guard Date().timeIntervalSince(last) >= (frequency == "daily" ? 86400 : 7 * 86400) else { return }
        do { _ = try await shared.create(store.repository, automatic: true) }
        catch { store.error = "自动备份未完成：" + error.localizedDescription }
    }
}

struct MobileBackupScreen: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var store: LibraryStore
    @AppStorage(MobileBackupArchive.frequencyKey) private var frequency = "off"
    @State private var files: [URL] = []
    @State private var choosing = false
    @State private var restoring: URL?
    @State private var busy = false
    @State private var error: String?
    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button("新建备份") { run { await store.preparation.pauseForDataChange(); _ = try await MobileBackupArchive.shared.create(store.repository) } }.disabled(busy || store.importing)
                    Button("从文件恢复…") { choosing = true }.disabled(busy || store.importing)
                    Picker("自动备份", selection: $frequency) { Text("关闭").tag("off"); Text("每天").tag("daily"); Text("每周").tag("weekly") }.disabled(busy)
                } footer: { if frequency != "off" { Text("回到书库时执行，保留最近三份自动备份。") } }
                Section {
                    ForEach(files, id: \.self) { url in
                        HStack {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(date(url), style: .date) + Text(" ") + Text(date(url), style: .time)
                                if url.lastPathComponent.contains("-auto-") { Text("自动备份").font(.caption).foregroundStyle(.secondary) }
                            }
                            Spacer()
                            Menu {
                                ShareLink("分享备份", item: url)
                                Button("恢复") { restoring = url }
                                Button("删除", role: .destructive) { do { try FileManager.default.removeItem(at: url); reload() } catch { self.error = error.localizedDescription } }
                            } label: { Image(systemName: "ellipsis") }.accessibilityLabel("备份操作")
                        }.disabled(busy)
                    }
                }
                if busy { ProgressView() }
                if let error { Text(error).foregroundStyle(.secondary) }
            }.navigationTitle("书库备份").navigationBarTitleDisplayMode(.inline)
                .toolbar { Button("完成") { dismiss() }.disabled(busy) }
                .task { reload() }
                .fileImporter(isPresented: $choosing, allowedContentTypes: [UTType("local.pagebetween.mobile-backup") ?? .zip]) { result in
                    switch result { case .success(let url): restoring = url; case .failure(let error): self.error = error.localizedDescription }
                }
                .confirmationDialog("恢复将替换手机书库，服务配置保留。", isPresented: Binding(get: { restoring != nil }, set: { if !$0 { restoring = nil } }), titleVisibility: .visible) {
                    Button("恢复书库", role: .destructive) { if let url = restoring { run { await store.preparation.pauseForDataChange(); _ = try await MobileBackupArchive.shared.create(store.repository); try await MobileBackupArchive.shared.restore(url, repository: store.repository); store.preparation.reset(); await store.refresh() } } }
                    Button("取消", role: .cancel) { restoring = nil }
                }
        }.tint(MobilePalette.accent).interactiveDismissDisabled(busy)
    }
    private func reload() { do { files = try MobileBackupArchive.list() } catch { self.error = error.localizedDescription } }
    private func date(_ url: URL) -> Date { (try? url.resourceValues(forKeys: [.creationDateKey]).creationDate) ?? .distantPast }
    private func run(_ action: @escaping @MainActor () async throws -> Void) {
        busy = true; error = nil
        Task { @MainActor in
            defer { busy = false; reload(); restoring = nil }
            do { try await action() } catch { self.error = error.localizedDescription }
        }
    }
}
