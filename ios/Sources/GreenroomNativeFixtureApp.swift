import SwiftUI

@main
struct GreenroomNativeFixtureApp: App {
    var body: some Scene {
        WindowGroup { RootView() }
    }
}

// Fault injection: which defects are active this launch, set exclusively via
// the launch environment (SIMCTL_CHILD_GREENROOM_FAULTS on the simctl side,
// stripped to GREENROOM_FAULTS in the child process). Never read from a URL,
// UserDefaults, or anything else a driving model could see or set — the
// planner only ever observes the accessibility tree, never this env var.
enum GreenroomFaults {
    static let active: Set<String> = {
        let raw = ProcessInfo.processInfo.environment["GREENROOM_FAULTS"] ?? ""
        return Set(raw.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty })
    }()

    static func has(_ id: String) -> Bool { active.contains(id) }
}

@MainActor
final class FixtureState: ObservableObject {
    @Published var tab = 0
    @Published var completedSessions = 7
    @Published var latestRating: Int? = nil
}

struct RootView: View {
    @StateObject private var state = FixtureState()
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.layoutDirection) private var layoutDirection
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        TabView(selection: $state.tab) {
            TodayView(state: state).tabItem { Label("Today", systemImage: "sun.max") }.tag(0)
            LibraryView(state: state).tabItem { Label("Library", systemImage: "books.vertical") }.tag(1)
            ProgressView(state: state).tabItem { Label("Progress", systemImage: "chart.line.uptrend.xyaxis") }.tag(2)
            SettingsView().tabItem { Label("Settings", systemImage: "gearshape") }.tag(3)
            PlanTabView().tabItem { Label("Plan", systemImage: "calendar") }.tag(4)
        }
        .tint(colorScheme == .dark ? Color(red: 0.4, green: 0.9, blue: 0.6) : Color(red: 0.05, green: 0.42, blue: 0.20))
        .overlay(alignment: .topLeading) {
            Color.clear
                .frame(width: 1, height: 1)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Greenroom environment")
                .accessibilityValue("\(colorScheme == .dark ? "dark" : "light") \(layoutDirection == .rightToLeft ? "RTL" : "LTR") \(dynamicTypeSize.isAccessibilitySize ? "accessibility" : "standard")")
        }
    }
}

struct TodayView: View {
    @ObservedObject var state: FixtureState
    @State private var showingSession = false

    var body: some View {
        NavigationStack {
            List {
                Section("Streak") { Text("2 days").font(.title2).bold() }
                Section("Next session") {
                    Text("Neck Ladder · 3 min")
                    Button("Start session") { showingSession = true }
                }
            }
            .navigationTitle("Today")
            .fullScreenCover(isPresented: $showingSession) {
                SessionView(exercise: "Neck Ladder", state: state, presented: $showingSession)
            }
        }
    }
}

struct Exercise: Identifiable, Hashable {
    let id: String
    let name: String
    let category: String
    let minutes: Int
}

let exercises = [
    Exercise(id: "neck-ladder", name: "Neck Ladder", category: "Neck", minutes: 3),
    Exercise(id: "wall-angels", name: "Wall Angels", category: "Shoulders", minutes: 4),
    Exercise(id: "chin-tucks", name: "Chin Tucks", category: "Neck", minutes: 2),
    Exercise(id: "hip-hinge", name: "Standing Hip Hinge", category: "Back", minutes: 4),
]

struct LibraryView: View {
    @ObservedObject var state: FixtureState
    @State private var query = ""
    @State private var category = "All"
    @State private var selected: Exercise?

    var filtered: [Exercise] {
        // Fault "search-wrong-filter": the search box is meant to match the
        // exercise name, but a defective build wires it to match the
        // category instead, so a name-only query like "Chin" returns no
        // exercise (no category is named "Chin").
        if GreenroomFaults.has("search-wrong-filter") && !query.isEmpty {
            return exercises.filter { (category == "All" || $0.category == category) && $0.category.localizedCaseInsensitiveContains(query) }
        }
        return exercises.filter { (category == "All" || $0.category == category) && (query.isEmpty || $0.name.localizedCaseInsensitiveContains(query)) }
    }

    var body: some View {
        NavigationStack {
            List {
                Picker("Category", selection: $category) {
                    ForEach(["All", "Neck", "Shoulders", "Back"], id: \.self) { Text($0) }
                }
                ForEach(filtered) { exercise in
                    Button {
                        selected = exercise
                    } label: {
                        HStack { Text(exercise.name); Spacer(); Text("\(exercise.category) · \(exercise.minutes) min").foregroundStyle(.secondary) }
                    }
                    .accessibilityLabel(exercise.name)
                }
                if filtered.isEmpty && !query.isEmpty {
                    Text("No matching exercises")
                }
            }
            .searchable(text: $query, prompt: "Search exercises")
            .navigationTitle("Library")
            .navigationDestination(item: $selected) { exercise in ExerciseDetail(exercise: exercise, state: state) }
        }
    }
}

struct ExerciseDetail: View {
    let exercise: Exercise
    @ObservedObject var state: FixtureState
    @State private var showingSession = false

    var body: some View {
        List {
            Text("\(exercise.minutes) min · \(exercise.category)")
            Text("Move slowly and keep the range comfortable.")
            Button("Start this exercise") { showingSession = true }
        }
        .navigationTitle(exercise.name)
        .fullScreenCover(isPresented: $showingSession) {
            SessionView(exercise: exercise.name, state: state, presented: $showingSession)
        }
    }
}

struct SessionView: View {
    let exercise: String
    @ObservedObject var state: FixtureState
    @Binding var presented: Bool
    @State private var step = 1
    @State private var rating: Int? = nil

    var body: some View {
        NavigationStack {
            VStack(spacing: 24) {
                if step <= 3 {
                    Text("Step \(step) of 3").font(.headline)
                    Text(["Settle into position and breathe out.", "Move slowly through the range.", "Last round. Slower than feels natural."][step - 1])
                    Button("Next") { step += 1 }.buttonStyle(.borderedProminent)
                        .tint(Color(red: 0.05, green: 0.42, blue: 0.20))
                } else {
                    Text("How did it feel?").font(.title2).bold()
                    HStack {
                        ForEach(1...5, id: \.self) { value in
                            Button { rating = value } label: {
                                Text("\(value)")
                                    .frame(minWidth: 44, minHeight: 44)
                                    .foregroundStyle(rating == value ? Color.white : Color.primary)
                                    .background(rating == value ? Color(red: 0.05, green: 0.42, blue: 0.20) : Color.green.opacity(0.14), in: Circle())
                            }
                                .buttonStyle(.plain)
                                .accessibilityLabel("\(value) star rating")
                                .accessibilityValue(rating == value ? "selected" : "not selected")
                        }
                    }
                    Button("Finish session") {
                        guard let rating else { return }
                        // Fault "rating-dropped": the rating the user picked
                        // is never written back to state, so it's missing
                        // from Progress history even though the session
                        // still counts.
                        if !GreenroomFaults.has("rating-dropped") { state.latestRating = rating }
                        // Fault "session-count-off": the completion counter
                        // increments by 2 instead of 1.
                        state.completedSessions += GreenroomFaults.has("session-count-off") ? 2 : 1
                        state.tab = 2
                        presented = false
                    }
                    .disabled(rating == nil)
                    .buttonStyle(.borderedProminent)
                    .tint(Color(red: 0.05, green: 0.42, blue: 0.20))
                }
                Spacer()
            }
            .padding()
            .navigationTitle(exercise)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("End early") { presented = false } } }
        }
    }
}

struct ProgressView: View {
    @ObservedObject var state: FixtureState
    var body: some View {
        NavigationStack {
            List {
                Section("Totals") { Text("\(state.completedSessions) sessions · streak 2 days") }
                Section("History") {
                    if let rating = state.latestRating {
                        Text("Latest session · \(String(repeating: "★", count: rating))")
                    } else {
                        Text("Latest session · not recorded")
                    }
                    Text("Wall Angels · ★★★★")
                    Text("Neck Ladder · ★★★★★")
                }
                Section("Achievements") { Text("First week done ✓") }
            }
            .navigationTitle("Progress")
        }
    }
}

struct SettingsView: View {
    var body: some View {
        NavigationStack {
            List {
                NavigationLink("Profile") { ProfileView() }
                NavigationLink("Reminders") { RemindersView() }
                NavigationLink("Notifications") { NotificationsView() }
                NavigationLink("About") { AboutView() }
            }
            .navigationTitle("Settings")
        }
    }
}

struct ProfileView: View {
    @AppStorage("units") private var units = "Centimeters"
    @State private var name = "Alex"
    var body: some View {
        Form {
            TextField("Name", text: $name)
            Picker("Measurement units", selection: $units) { Text("Centimeters").tag("Centimeters"); Text("Inches").tag("Inches") }
        }
        .navigationTitle("Profile")
        // Fault "units-persist": the picker visibly changes when tapped, but
        // a stale re-read on every reappearance stomps the saved value back
        // to the default, so the selection never survives a trip away and
        // back.
        .onAppear { if GreenroomFaults.has("units-persist") { units = "Centimeters" } }
    }
}

struct RemindersView: View {
    @AppStorage("sessionReminders") private var reminders = true
    var body: some View {
        Form { Toggle("Session reminders", isOn: $reminders); LabeledContent("Reminder time", value: "9:30 AM") }
            .navigationTitle("Reminders")
            // Fault "reminder-persist": same class of bug as units-persist —
            // the toggle writes through, but reappearing resets it to the
            // default, so turning reminders off never sticks.
            .onAppear { if GreenroomFaults.has("reminder-persist") { reminders = true } }
    }
}

struct NotificationsView: View {
    @State private var streak = true
    @State private var weekly = false
    var body: some View {
        Form { Toggle("Streak alerts", isOn: $streak); Toggle("Weekly summary", isOn: $weekly); Toggle("Posture tips", isOn: .constant(true)) }
            .navigationTitle("Notifications")
    }
}

struct AboutView: View {
    var body: some View {
        List { LabeledContent("Version", value: "1.0.0 (1)"); Text("Terms of service") }
            .navigationTitle("About")
    }
}

// MARK: - Plan tab

struct PlanDay: Identifiable {
    let id: String
    let name: String
    var exerciseIds: [String]
}

@MainActor
final class PlanState: ObservableObject {
    @Published var days: [PlanDay] = [
        PlanDay(id: "monday", name: "Monday", exerciseIds: ["wall-angels", "neck-ladder"]),
        PlanDay(id: "wednesday", name: "Wednesday", exerciseIds: ["hip-hinge"]),
        PlanDay(id: "friday", name: "Friday", exerciseIds: ["chin-tucks"]),
    ]
    @Published var weeklyTarget = 5

    // Snapshot taken at launch. Only the "target-summary-stale" fault ever
    // reads it back (see summaryTarget below).
    private let launchTarget = 5

    // The value the Weekly Plan root list's summary row displays. Fault
    // "target-summary-stale": the row renders a stale launch-time snapshot
    // instead of the live value, so the detail screen and the summary row
    // contradict each other after any change to the target.
    var summaryTarget: Int {
        GreenroomFaults.has("target-summary-stale") ? launchTarget : weeklyTarget
    }

    func exercises(for day: PlanDay) -> [Exercise] {
        day.exerciseIds.compactMap { id in exercisesById[id] }
    }

    func add(exerciseId: String, toDay dayId: String) {
        guard var index = days.firstIndex(where: { $0.id == dayId }) else { return }
        // Fault "plan-wrong-day": the commit writes to the day AFTER the one
        // the user was editing, so the edited day never changes and a
        // different day silently grows.
        if GreenroomFaults.has("plan-wrong-day") { index = (index + 1) % days.count }
        // Adds are idempotent: a day never lists the same exercise twice, so
        // re-committing the same add (e.g. a driver retrying what looks like
        // a failed tap) leaves state unchanged instead of compounding. This
        // keeps the injected fault's footprint fixed at exactly one
        // misdirected write no matter how many times the add is retried.
        guard !days[index].exerciseIds.contains(exerciseId) else { return }
        days[index].exerciseIds.append(exerciseId)
    }
}

let exercisesById = Dictionary(uniqueKeysWithValues: exercises.map { ($0.id, $0) })

func planCountText(_ count: Int) -> String {
    count == 1 ? "1 exercise" : "\(count) exercises"
}

struct PlanTabView: View {
    @StateObject private var plan = PlanState()

    var body: some View {
        NavigationStack {
            List {
                Section("Days") {
                    ForEach(plan.days) { day in
                        NavigationLink {
                            PlanDayDetailView(plan: plan, dayId: day.id)
                        } label: {
                            LabeledContent(day.name, value: planCountText(day.exerciseIds.count))
                        }
                    }
                }
                Section("Goal") {
                    NavigationLink {
                        WeeklyTargetView(plan: plan)
                    } label: {
                        LabeledContent("Weekly target", value: "\(plan.summaryTarget) sessions")
                    }
                }
            }
            .navigationTitle("Weekly Plan")
        }
    }
}

struct PlanDayDetailView: View {
    @ObservedObject var plan: PlanState
    let dayId: String

    var day: PlanDay { plan.days.first { $0.id == dayId } ?? plan.days[0] }

    var body: some View {
        let planned = plan.exercises(for: day)
        List {
            Section("Exercises") {
                ForEach(Array(planned.enumerated()), id: \.offset) { _, exercise in
                    HStack { Text(exercise.name); Spacer(); Text("\(exercise.minutes) min").foregroundStyle(.secondary) }
                }
            }
            Section("Summary") {
                Text("\(planned.count) planned · \(planned.reduce(0) { $0 + $1.minutes }) min")
            }
            NavigationLink("Add exercise") { ChooseExerciseView(plan: plan, dayId: dayId) }
        }
        .navigationTitle(day.name)
    }
}

struct ChooseExerciseView: View {
    @ObservedObject var plan: PlanState
    let dayId: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        List {
            ForEach(exercises) { exercise in
                Button {
                    plan.add(exerciseId: exercise.id, toDay: dayId)
                    dismiss()
                } label: {
                    HStack { Text(exercise.name); Spacer(); Text("\(exercise.minutes) min").foregroundStyle(.secondary) }
                }
                .accessibilityLabel(exercise.name)
            }
        }
        .navigationTitle("Choose exercise")
    }
}

struct WeeklyTargetView: View {
    @ObservedObject var plan: PlanState

    var body: some View {
        List {
            Text("Target: \(plan.weeklyTarget) sessions per week")
            Button("Increase target") { plan.weeklyTarget += 1 }
            Button("Decrease target") { plan.weeklyTarget = max(1, plan.weeklyTarget - 1) }
        }
        .navigationTitle("Weekly target")
    }
}
