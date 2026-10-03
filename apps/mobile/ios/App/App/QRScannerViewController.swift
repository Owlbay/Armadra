import AVFoundation
import UIKit

/// 整屏扫码：相机预览，认到第一个二维码就关；左上角系统「取消」（系统自带本地化，
/// 不另写文案）。没有相机（模拟器）或没给权限时直接按取消处理。
final class QRScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    private let session = AVCaptureSession()
    private var completion: ((String?) -> Void)?
    private var preview: AVCaptureVideoPreviewLayer?

    static func present(from presenter: UIViewController, completion: @escaping (String?) -> Void) {
        let start = {
            DispatchQueue.main.async {
                guard AVCaptureDevice.default(for: .video) != nil,
                      AVCaptureDevice.authorizationStatus(for: .video) == .authorized
                else {
                    completion(nil)
                    return
                }
                let scanner = QRScannerViewController()
                scanner.completion = completion
                let navigation = UINavigationController(rootViewController: scanner)
                navigation.modalPresentationStyle = .fullScreen
                presenter.present(navigation, animated: true)
            }
        }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { _ in start() }
        default:
            start()
        }
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        navigationItem.leftBarButtonItem = UIBarButtonItem(
            barButtonSystemItem: .cancel, target: self, action: #selector(cancel)
        )
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input)
        else { return }
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { return }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]
        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        view.layer.addSublayer(layer)
        preview = layer
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = view.bounds
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        let session = self.session
        DispatchQueue.global(qos: .userInitiated).async { session.startRunning() }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        session.stopRunning()
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard let code = metadataObjects.compactMap({ $0 as? AVMetadataMachineReadableCodeObject }).first,
              let text = code.stringValue, !text.isEmpty
        else { return }
        finish(text)
    }

    @objc private func cancel() {
        finish(nil)
    }

    private func finish(_ text: String?) {
        guard let completion else { return }
        self.completion = nil
        session.stopRunning()
        dismiss(animated: true) { completion(text) }
    }
}
