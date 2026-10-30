import SwiftUI
import PDFKit

@MainActor final class PDFPreparationStore: ObservableObject {
    @Published var jobs: [UUID: PDFPreparationTask] = [:]
    @Published var revision = 0
    @Published var mineruJobs: [UUID: PDFPreparationTask] = [:]
    let repository: LibraryRepository
    let worker: PDFTextPreparation
    let mineru: MobileMinerU
    private var running: [UUID: Task<Void, Never>] = [:]
    private var nearby: [UUID: Task<Void, Never>] = [:]
    private var cloudRunning: [UUID: Task<Void, Never>] = [:]
    init(repository: LibraryRepository) { self.repository = repository; worker = PDFTextPreparation(repository: repository); mineru = MobileMinerU(repository: repository) }

    func restore(_ book: MobileBook) async {
        if cloudRunning[book.id] == nil, mineruJobs[book.id] == nil {
            do { mineruJobs[book.id] = try await repository.mineruCheckpoint(book.id)?.task }
            catch { var task = PDFPreparationTask(book: book.id, sourceHash: book.sourceHash, engine: "mineru", pages: []); task.state = "failed"; task.message = "保存的云解析任务无法读取，请重新提交。"; mineruJobs[book.id] = task }
        }
        guard running[book.id] == nil, jobs[book.id] == nil else { return }
        do { jobs[book.id] = try await repository.pdfTask(book.id, engine: "ocr") }
        catch { var task = PDFPreparationTask(book: book.id, sourceHash: book.sourceHash, engine: "ocr", pages: []); task.state = "failed"; task.message = error.localizedDescription; jobs[book.id] = task }
    }
    func prepareNearby(_ book: MobileBook, page: Int, total: Int) {
        guard running[book.id] == nil else { return }
        nearby[book.id]?.cancel()
        nearby[book.id] = Task {
            guard let live = await repository.books().first(where: { $0.id == book.id }), live.shouldPrepare else { return }
            for candidate in [page, page + 1, page + 2, page - 1] where candidate > 0 && candidate <= total {
                guard !Task.isCancelled else { return }
                do {
                    let previous = try await repository.pdfPage(book.id, page: candidate)?.ocrRevision
                    let result = try await worker.prepare(book, page: candidate)
                    if result.ocrRevision != previous { revision += 1 }
                }
                catch is CancellationError { return }
                catch { return }
            }
        }
    }
    func start(_ book: MobileBook, pages: [Int], fresh: Bool = false) {
        guard running[book.id] == nil, !pages.isEmpty else { return }
        nearby[book.id]?.cancel()
        running[book.id] = Task {
            var task = PDFPreparationTask(book: book.id, sourceHash: book.sourceHash, engine: "ocr", pages: pages)
            if !fresh, let previous = jobs[book.id], previous.sourceHash == book.sourceHash, previous.pages == pages { task = previous }
            if fresh { task.completed = [] }
            task.state = "running"
            jobs[book.id] = task
            do {
                try await repository.savePDFTask(task)
                for page in pages {
                    try Task.checkCancellation()
                    task.message = "准备第 \(page) 页"; jobs[book.id] = task
                    _ = try await worker.prepare(book, page: page, fresh: fresh)
                    if !task.completed.contains(page) { task.completed.append(page) }
                    task.updatedAt = Date(); revision += 1
                    jobs[book.id] = task; try await repository.savePDFTask(task)
                }
                task.state = Task.isCancelled ? "paused" : "done"; task.message = ""
            } catch is CancellationError { task.state = "paused"; task.message = "" }
            catch { task.state = "failed"; task.message = error.localizedDescription }
            jobs[book.id] = task
            do { try await repository.savePDFTask(task) } catch { task.state = "failed"; task.message = error.localizedDescription; jobs[book.id] = task }
            running[book.id] = nil
        }
    }
    func pause(_ id: UUID) { running[id]?.cancel(); nearby[id]?.cancel(); cloudRunning[id]?.cancel() }
    func startMinerU(_ book: MobileBook, pages: [Int], fresh: Bool = false) {
        guard cloudRunning[book.id] == nil, !pages.isEmpty else { return }
        let services = MobileServices(), profile = services.mineru, key = SecureKeys.read("mineru")
        cloudRunning[book.id] = Task {
            do {
                try await mineru.run(book, pages: pages, profile: profile, key: key, fresh: fresh) { task in await self.cloudProgress(task) }
            } catch {
                if let failure = error as? MinerUFailure, failure == .unfinishedTask, var previous = mineruJobs[book.id] {
                    previous.message = failure.localizedDescription; mineruJobs[book.id] = previous
                } else if mineruJobs[book.id]?.state == "running" || mineruJobs[book.id] == nil || (error as? MinerUFailure) == .configuration {
                    var task = PDFPreparationTask(book: book.id, sourceHash: book.sourceHash, engine: "mineru", pages: pages)
                    task.state = Task.isCancelled ? "paused" : "failed"
                    task.message = (error as? MinerUFailure)?.localizedDescription ?? "解析未完成，请检查网络或服务设置。"
                    mineruJobs[book.id] = task
                }
            }
            cloudRunning[book.id] = nil
        }
    }
    private func cloudProgress(_ task: PDFPreparationTask) { mineruJobs[task.book] = task; revision += 1 }
    func pauseMinerU(_ id: UUID) { cloudRunning[id]?.cancel() }
    func pauseAll() { for task in running.values { task.cancel() }; for task in nearby.values { task.cancel() }; for task in cloudRunning.values { task.cancel() } }
}
